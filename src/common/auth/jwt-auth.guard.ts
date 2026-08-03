import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { jwtVerify, decodeJwt } from "jose";
import type { JWTPayload } from "jose";
import { PORTAL_AUDIENCE } from "../portal-auth/portal-claims";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import type { Redis } from "@upstash/redis";
import { IS_PUBLIC } from "./public.decorator";
import { ALLOW_NO_ORG_KEY } from "./allow-no-org.decorator";
import {
  INTERNAL_TOKEN_AUDIENCE,
  INTERNAL_TOKEN_ISSUER,
  type BackendClaims,
  type CurrentUserContext,
} from "./backend-claims";
import { backendJwtPayloadSchema } from "./backend-claims-schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { withIdentity } from "../tenant/with-identity";
import { runInTenantTransaction } from "../tenant/run-in-tenant-transaction";
import { REDIS } from "../../common/cache/cache.service";
import {
  hashApiToken,
  isModernApiToken,
  legacyApiTokenPrefix,
} from "./api-token-hash";
import { organizationMembers, userApiTokens, users } from "../../db/schema";

interface OrgContext {
  orgId: string;
  role: string;
  isOwner: boolean;
}

interface OrgContextEntry {
  value: OrgContext;
  expiresAt: number;
}


const ORG_CTX_TTL_MS = 60_000;
const REVOCATION_CACHE_TTL_MS = 5_000;

interface MembershipState {
  active: boolean;
  isOwner: boolean;
  role: string;
}

interface MembershipStateEntry {
  value: MembershipState;
  expiresAt: number;
}

const MEMBERSHIP_STATUS_TTL_MS = 15_000;
const membershipStatusCache = new Map<string, MembershipStateEntry>();

/** Bust the cached active-membership and account-status checks so a status change takes effect immediately. */
export function bustMembershipStatusCache(userId: string, orgId?: string): void {
  membershipStatusCache.delete(`${userId}:account`);
  if (orgId) {
    membershipStatusCache.delete(`${userId}:${orgId}`);
    return;
  }
  for (const key of Array.from(membershipStatusCache.keys())) {
    if (key.startsWith(`${userId}:`)) membershipStatusCache.delete(key);
  }
}

function extractClaims(payload: JWTPayload): BackendClaims | null {
  const parsed = backendJwtPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  return {
    sub: parsed.data.sub,
    orgId: parsed.data.orgId ?? null,
    sessionId: parsed.data.sessionId,
  };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly orgCtxCache = new Map<string, OrgContextEntry>();
  private readonly revocationCache = new Map<string, number>();
  private readonly jwtSecretKey: Uint8Array | null;

  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {
    const raw = process.env.BACKEND_JWT_SECRET;
    this.jwtSecretKey = raw ? new TextEncoder().encode(raw) : null;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserContext }>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Unauthorized");
    }
    const token = header.slice("Bearer ".length).trim();
    if (!this.jwtSecretKey) throw new UnauthorizedException("Unauthorized");

    try {
      const raw = decodeJwt(token);
      const rawAud = raw.aud;
      if (
        rawAud === PORTAL_AUDIENCE ||
        (Array.isArray(rawAud) && rawAud.includes(PORTAL_AUDIENCE))
      ) {
        throw new UnauthorizedException("Unauthorized");
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
    }

    let claims: BackendClaims | null = null;
    try {
      const { payload } = await jwtVerify(token, this.jwtSecretKey, {
        algorithms: ["HS256"],
        audience: INTERNAL_TOKEN_AUDIENCE,
        issuer: INTERNAL_TOKEN_ISSUER,
      });
      claims = extractClaims(payload);
    } catch {
      // JWT verification failed — fall through to PAT check
    }

    if (claims !== null) {
      if (this.redis && !claims.sessionId.startsWith("pat:")) {
        const cachedOk = this.revocationCache.get(claims.sessionId);
        if (!(cachedOk && cachedOk > Date.now())) {
          const revoked = await this.redis.get<boolean>(
            `revoked:session:${claims.sessionId}`,
          );
          if (revoked) {
            this.revocationCache.delete(claims.sessionId);
            throw new UnauthorizedException("Session has been revoked");
          }
          this.revocationCache.set(
            claims.sessionId,
            Date.now() + REVOCATION_CACHE_TTL_MS,
          );
          if (this.revocationCache.size > 10000) {
            const now = Date.now();
            for (const [key, exp] of this.revocationCache) {
              if (exp <= now) this.revocationCache.delete(key);
            }
          }
        }
      }
      const allowNoOrg = this.reflector.getAllAndOverride<boolean>(
        ALLOW_NO_ORG_KEY,
        [context.getHandler(), context.getClass()],
      );
      const path = req.path ?? req.url?.split("?")[0] ?? "";
      const isOrgSetup = req.method === "PATCH" && path === "/org/setup";

      let orgId = claims.orgId;

      if (!orgId) {
        const resolved = await this.resolveOrgContext(claims.sub);
        if (resolved) orgId = resolved.orgId;
      }

      // 403, not 401: the session is valid — a 401 would make the api-client force a sign-out loop for users who haven't created their org yet.
      if (!orgId && !allowNoOrg && !isOrgSetup) {
        throw new ForbiddenException("Organization not found");
      }

      const accountActive = await this.checkUserAccountActive(claims.sub);
      if (!accountActive) {
        throw new UnauthorizedException("Unauthorized");
      }

      let role = "";
      let isOrgOwner = false;

      if (orgId) {
        const membership = await this.resolveMembershipState(claims.sub, orgId);
        if (!membership.active) {
          throw new UnauthorizedException("Unauthorized");
        }
        role = membership.role;
        isOrgOwner = membership.isOwner;
      }

      req.user = {
        userId: claims.sub,
        orgId: orgId ?? "",
        role,
        permissions: [],
        isOrgOwner,
        sessionId: claims.sessionId,
        tokenScopes: null,
      };
      return true;
    }

    const userCtx = await this.tryPatAuth(token);
    if (userCtx) {
      req.user = userCtx;
      return true;
    }

    throw new UnauthorizedException("Unauthorized");
  }

  private async resolveMembershipState(
    userId: string,
    orgId: string,
  ): Promise<MembershipState> {
    const key = `${userId}:${orgId}`;
    const cached = membershipStatusCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let state: MembershipState = { active: true, isOwner: false, role: "" };
    try {
      const rows = await runInTenantTransaction(
        this.db,
        (tx) =>
          tx
            .select({
              status: organizationMembers.status,
              isOwner: organizationMembers.isOwner,
              role: organizationMembers.role,
              userIsActive: users.isActive,
              userDeletedAt: users.deletedAt,
            })
            .from(organizationMembers)
            .innerJoin(users, eq(users.id, organizationMembers.userId))
            .where(
              and(
                eq(organizationMembers.userId, userId),
                eq(organizationMembers.orgId, orgId),
              ),
            )
            .orderBy(desc(organizationMembers.joinedAt))
            .limit(1),
        { orgId },
      );
      const row = rows[0];
      if (row) {
        const active =
          row.status !== "SUSPENDED" &&
          row.status !== "LEFT" &&
          row.userIsActive &&
          row.userDeletedAt === null;
        state = { active, isOwner: row.isOwner, role: row.role };
      }
    } catch {
      state = { active: true, isOwner: false, role: "" };
    }

    membershipStatusCache.set(key, {
      value: state,
      expiresAt: Date.now() + MEMBERSHIP_STATUS_TTL_MS,
    });
    return state;
  }

  private async checkUserAccountActive(userId: string): Promise<boolean> {
    const key = `${userId}:account`;
    const cached = membershipStatusCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value.active;

    let active = true;
    try {
      const rows = await this.db
        .select({
          isActive: users.isActive,
          deletedAt: users.deletedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const row = rows[0];
      if (row && (!row.isActive || row.deletedAt !== null)) active = false;
    } catch {
      active = true;
    }

    membershipStatusCache.set(key, {
      value: { active, isOwner: false, role: "" },
      expiresAt: Date.now() + MEMBERSHIP_STATUS_TTL_MS,
    });
    return active;
  }

  private async resolveOrgContext(userId: string): Promise<OrgContext | null> {
    const cached = this.orgCtxCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const result = await this.fetchOrgContext(userId);
    if (result !== null) {
      this.orgCtxCache.set(userId, { value: result, expiresAt: Date.now() + ORG_CTX_TTL_MS });
      if (this.orgCtxCache.size > 5000) {
        const now = Date.now();
        for (const [key, entry] of this.orgCtxCache) {
          if (entry.expiresAt <= now) this.orgCtxCache.delete(key);
        }
      }
    }
    return result;
  }

  private async fetchOrgContext(userId: string): Promise<OrgContext | null> {
    const [user, rows] = await Promise.all([
      this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { lastActiveOrgId: true },
      }),
      withIdentity(this.db, userId, (tx) =>
        tx
          .select({
            orgId: organizationMembers.orgId,
            role: organizationMembers.role,
            isOwner: organizationMembers.isOwner,
          })
          .from(organizationMembers)
          .where(eq(organizationMembers.userId, userId))
          .orderBy(desc(organizationMembers.joinedAt)),
      ),
    ]);

    const preferred = user?.lastActiveOrgId
      ? rows.find((r) => r.orgId === user.lastActiveOrgId)
      : undefined;
    const member = preferred ?? rows[0];
    if (!member) return null;

    return {
      orgId: member.orgId,
      role: member.role,
      isOwner: member.isOwner,
    };
  }

  private async tryPatAuth(
    rawToken: string,
  ): Promise<CurrentUserContext | null> {
    const matched = await this.findApiToken(rawToken);
    if (!matched) return null;

    void this.db
      .update(userApiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(userApiTokens.id, matched.id))
      .catch(() => undefined);

    const [user, resolved] = await Promise.all([
      this.db.query.users.findFirst({
        where: eq(users.id, matched.userId),
        columns: { id: true, isActive: true, deletedAt: true },
      }),
      this.resolveOrgContext(matched.userId),
    ]);

    if (!user || !resolved) return null;
    if (!user.isActive || user.deletedAt !== null) return null;

    return {
      userId: matched.userId,
      orgId: resolved.orgId,
      role: resolved.role,
      permissions: [],
      isOrgOwner: resolved.isOwner,
      sessionId: `pat:${matched.id}`,
      tokenScopes: matched.scopes.length > 0 ? matched.scopes : null,
    };
  }

  private async findApiToken(
    rawToken: string,
  ): Promise<{ id: string; userId: string; scopes: string[] } | null> {
    const now = new Date();
    const liveToken = and(
      isNull(userApiTokens.revokedAt),
      or(isNull(userApiTokens.expiresAt), gt(userApiTokens.expiresAt, now)),
    );

    const digest = hashApiToken(rawToken);
    const [direct] = await this.db
      .select({
        id: userApiTokens.id,
        userId: userApiTokens.userId,
        scopes: userApiTokens.scopes,
      })
      .from(userApiTokens)
      .where(and(eq(userApiTokens.tokenHash, digest), liveToken))
      .limit(1);
    if (direct) return direct;

    if (isModernApiToken(rawToken)) return null;

    const legacyRows = await this.db
      .select({
        id: userApiTokens.id,
        userId: userApiTokens.userId,
        tokenHash: userApiTokens.tokenHash,
        scopes: userApiTokens.scopes,
      })
      .from(userApiTokens)
      .where(
        and(
          eq(userApiTokens.prefix, legacyApiTokenPrefix(rawToken)),
          eq(userApiTokens.hashAlg, "bcrypt"),
          liveToken,
        ),
      );

    for (const row of legacyRows) {
      if (!(await bcrypt.compare(rawToken, row.tokenHash))) continue;

      void this.db
        .update(userApiTokens)
        .set({ tokenHash: digest, hashAlg: "sha256" })
        .where(eq(userApiTokens.id, row.id))
        .catch(() => undefined);

      return { id: row.id, userId: row.userId, scopes: row.scopes };
    }

    return null;
  }
}
