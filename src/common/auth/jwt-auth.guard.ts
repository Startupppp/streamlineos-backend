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
import { and, desc, eq } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import type { Redis } from "@upstash/redis";
import { IS_PUBLIC } from "./public.decorator";
import { ALLOW_NO_ORG_KEY } from "./allow-no-org.decorator";
import type { BackendClaims, CurrentUserContext } from "./backend-claims";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { REDIS } from "../../common/cache/cache.service";
import {
  organizationMembers,
  subscriptions,
  userApiTokens,
  users,
} from "../../db/schema";

interface OrgContext {
  orgId: string;
  role: string;
  isOwner: boolean;
  plan: string | null;
}

interface OrgContextEntry {
  value: OrgContext;
  expiresAt: number;
}

interface PlatformAdminEntry {
  value: boolean;
  expiresAt: number;
}

const ORG_CTX_TTL_MS = 60_000;
const PLATFORM_ADMIN_TTL_MS = 30_000;
const REVOCATION_CACHE_TTL_MS = 5_000;

const platformAdminCache = new Map<string, PlatformAdminEntry>();

export function bustPlatformAdminCache(userId: string): void {
  platformAdminCache.delete(userId);
}

interface MembershipStatusEntry {
  active: boolean;
  expiresAt: number;
}

const MEMBERSHIP_STATUS_TTL_MS = 15_000;
const membershipStatusCache = new Map<string, MembershipStatusEntry>();

/** Bust the cached active-membership check so a suspend/leave takes effect immediately. */
export function bustMembershipStatusCache(userId: string, orgId?: string): void {
  if (orgId) {
    membershipStatusCache.delete(`${userId}:${orgId}`);
    return;
  }
  for (const key of Array.from(membershipStatusCache.keys())) {
    if (key.startsWith(`${userId}:`)) membershipStatusCache.delete(key);
  }
}

function extractClaims(payload: JWTPayload): BackendClaims {
  return {
    sub: typeof payload.sub === "string" ? payload.sub : "",
    orgId:
      typeof payload["orgId"] === "string" && payload["orgId"] !== ""
        ? payload["orgId"]
        : null,
    branchId:
      typeof payload["branchId"] === "string" ? payload["branchId"] : null,
    role: typeof payload["role"] === "string" ? payload["role"] : "",
    permissions: Array.isArray(payload["permissions"])
      ? payload["permissions"].filter((x): x is string => typeof x === "string")
      : [],
    enabledModules: Array.isArray(payload["enabledModules"])
      ? payload["enabledModules"].filter(
          (x): x is string => typeof x === "string",
        )
      : [],
    plan: typeof payload["plan"] === "string" ? payload["plan"] : null,
    isPlatformAdmin: false,
    isOrgOwner: payload["isOrgOwner"] === true,
    sessionId:
      typeof payload["sessionId"] === "string" ? payload["sessionId"] : "",
  };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly orgCtxCache = new Map<string, OrgContextEntry>();
  private readonly revocationCache = new Map<string, number>();
  private readonly jwtSecretKey: Uint8Array | null;
  private readonly db_resolvePlatformAdmin: (userId: string) => Promise<boolean>;

  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {
    const raw = process.env.BACKEND_JWT_SECRET;
    this.jwtSecretKey = raw ? new TextEncoder().encode(raw) : null;
    this.db_resolvePlatformAdmin = async (userId: string): Promise<boolean> => {
      const cached = platformAdminCache.get(userId);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      try {
        const row = await this.db.query.users.findFirst({
          where: eq(users.id, userId),
          columns: { isPlatformAdmin: true },
        });
        const value = row?.isPlatformAdmin ?? false;
        platformAdminCache.set(userId, { value, expiresAt: Date.now() + PLATFORM_ADMIN_TTL_MS });
        if (platformAdminCache.size > 5000) {
          const now = Date.now();
          for (const [key, entry] of platformAdminCache) {
            if (entry.expiresAt <= now) platformAdminCache.delete(key);
          }
        }
        return value;
      } catch {
        return false;
      }
    };
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
      });
      claims = extractClaims(payload);
    } catch {
      // JWT verification failed — fall through to PAT check
    }

    if (claims !== null) {
      if (!claims.sub) throw new UnauthorizedException("Unauthorized");

      if (!claims.sessionId) throw new UnauthorizedException("Unauthorized");

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

      const isPlatformAdmin = await this.db_resolvePlatformAdmin(claims.sub);

      let orgId = claims.orgId;
      let isOrgOwner = claims.isOrgOwner;
      let role = claims.role;
      let plan = claims.plan;

      if (!orgId && !isPlatformAdmin) {
        const resolved = await this.resolveOrgContext(claims.sub);
        if (resolved) {
          orgId = resolved.orgId;
          isOrgOwner = resolved.isOwner;
          role = role || resolved.role;
          plan = plan ?? resolved.plan;
        }
      }

      // 403, not 401: the session is valid — a 401 would make the api-client force a sign-out loop for users who haven't created their org yet.
      if (!orgId && !isPlatformAdmin && !allowNoOrg && !isOrgSetup) {
        throw new ForbiddenException("Organization not found");
      }

      // Re-check membership every request so a suspended/left member loses access within the
      // cache TTL rather than only at JWT expiry (platform admins are exempt).
      if (orgId && !isPlatformAdmin) {
        const membershipActive = await this.isMembershipActive(claims.sub, orgId);
        if (!membershipActive) {
          throw new ForbiddenException(
            "Your organization membership is suspended or no longer active",
          );
        }
      }

      req.user = {
        userId: claims.sub,
        orgId: orgId ?? "",
        branchId: claims.branchId ?? null,
        role,
        permissions: claims.permissions,
        enabledModules: [],
        plan,
        isPlatformAdmin,
        isOrgOwner,
        sessionId: claims.sessionId,
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

  /**
   * Re-validate active membership on each request (versioned JWTs are hints, not authority).
   * Rejects ONLY an explicit SUSPENDED/LEFT membership; ACTIVE, unknown status, a missing row,
   * or any query error all pass, so a transient failure or un-migrated column cannot lock the
   * whole org out. Cached briefly so this is ~one query per user per window, not per request.
   */
  private async isMembershipActive(userId: string, orgId: string): Promise<boolean> {
    const key = `${userId}:${orgId}`;
    const cached = membershipStatusCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.active;

    let active = true;
    try {
      const rows = await this.db
        .select({ status: organizationMembers.status })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.orgId, orgId),
          ),
        )
        .orderBy(desc(organizationMembers.joinedAt))
        .limit(1);
      const status = rows[0]?.status;
      if (status === "SUSPENDED" || status === "LEFT") active = false;
    } catch {
      active = true;
    }

    membershipStatusCache.set(key, {
      active,
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
      this.db
        .select({
          orgId: organizationMembers.orgId,
          role: organizationMembers.role,
          isOwner: organizationMembers.isOwner,
        })
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, userId))
        .orderBy(desc(organizationMembers.joinedAt)),
    ]);

    const preferred = user?.lastActiveOrgId
      ? rows.find((r) => r.orgId === user.lastActiveOrgId)
      : undefined;
    const member = preferred ?? rows[0];
    if (!member) return null;

    const subscription = await this.db
      .select({ plan: subscriptions.plan })
      .from(subscriptions)
      .where(eq(subscriptions.orgId, member.orgId))
      .limit(1)
      .then((r) => r[0] ?? null);

    return {
      orgId: member.orgId,
      role: member.role,
      isOwner: member.isOwner,
      plan: subscription?.plan ?? null,
    };
  }

  private async tryPatAuth(
    rawToken: string,
  ): Promise<CurrentUserContext | null> {
    const prefix = rawToken.slice(0, 8);

    const rows = await this.db
      .select({
        id: userApiTokens.id,
        userId: userApiTokens.userId,
        tokenHash: userApiTokens.tokenHash,
        expiresAt: userApiTokens.expiresAt,
      })
      .from(userApiTokens)
      .where(eq(userApiTokens.prefix, prefix));

    let matchedUserId: string | null = null;
    let matchedTokenId: string | null = null;

    for (const row of rows) {
      if (row.expiresAt && row.expiresAt < new Date()) continue;

      const valid = await bcrypt.compare(rawToken, row.tokenHash);
      if (!valid) continue;

      matchedUserId = row.userId;
      matchedTokenId = row.id;
      break;
    }

    if (!matchedUserId || !matchedTokenId) return null;

    void this.db
      .update(userApiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(userApiTokens.id, matchedTokenId))
      .catch(() => undefined);

    const [user, resolved] = await Promise.all([
      this.db.query.users.findFirst({
        where: eq(users.id, matchedUserId),
        columns: { id: true, branchId: true, role: true },
      }),
      this.resolveOrgContext(matchedUserId),
    ]);

    if (!user || !resolved) return null;

    return {
      userId: matchedUserId,
      orgId: resolved.orgId,
      branchId: user.branchId ?? null,
      role: resolved.role,
      permissions: [],
      enabledModules: [],
      plan: resolved.plan,
      isPlatformAdmin: false,
      isOrgOwner: resolved.isOwner,
      sessionId: `pat:${matchedTokenId}`,
    };
  }
}
