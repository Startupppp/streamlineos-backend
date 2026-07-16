import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

interface OrgContext {
  orgId: string;
  role: string;
  isOwner: boolean;
  enabledModules: string[];
  plan: string | null;
}

interface OrgContextEntry {
  value: OrgContext;
  expiresAt: number;
}

const ORG_CTX_TTL_MS = 60_000;
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { desc, eq } from "drizzle-orm";
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
  organizations,
  subscriptions,
  userApiTokens,
  users,
} from "../../db/schema";

function extractClaims(payload: JWTPayload): BackendClaims {
  return {
    sub: typeof payload.sub === "string" ? payload.sub : "",
    orgId:
      typeof payload["orgId"] === "string" && payload["orgId"] !== ""
        ? payload["orgId"]
        : null,
    branchId:
      typeof payload["branchId"] === "number" ? payload["branchId"] : null,
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
    isPlatformAdmin: payload["isPlatformAdmin"] === true,
    isOrgOwner: payload["isOrgOwner"] === true,
    sessionId:
      typeof payload["sessionId"] === "string" ? payload["sessionId"] : "",
  };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly orgCtxCache = new Map<string, OrgContextEntry>();

  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

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
    const secret = process.env.BACKEND_JWT_SECRET;
    if (!secret) throw new UnauthorizedException("Unauthorized");

    let claims: BackendClaims | null = null;
    try {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(secret),
        { algorithms: ["HS256"] },
      );
      claims = extractClaims(payload);
    } catch {
      // JWT verification failed — fall through to PAT check
    }

    if (claims !== null) {
      if (!claims.sub) throw new UnauthorizedException("Unauthorized");

      if (!claims.sessionId) throw new UnauthorizedException("Unauthorized");

      if (this.redis && !claims.sessionId.startsWith("pat:")) {
        const revoked = await this.redis.get<boolean>(
          `revoked:session:${claims.sessionId}`,
        );
        if (revoked)
          throw new UnauthorizedException("Session has been revoked");
      }
      const allowNoOrg = this.reflector.getAllAndOverride<boolean>(
        ALLOW_NO_ORG_KEY,
        [context.getHandler(), context.getClass()],
      );
      const path = req.path ?? req.url?.split("?")[0] ?? "";
      const isOrgSetup = req.method === "PATCH" && path === "/org/setup";

      let orgId = claims.orgId;
      let isOrgOwner = claims.isOrgOwner;
      let role = claims.role;
      let enabledModules = claims.enabledModules;
      let plan = claims.plan;

      if (!orgId && !claims.isPlatformAdmin) {
        const resolved = await this.resolveOrgContext(claims.sub);
        if (resolved) {
          orgId = resolved.orgId;
          isOrgOwner = resolved.isOwner;
          role = role || resolved.role;
          enabledModules =
            enabledModules.length > 0
              ? enabledModules
              : resolved.enabledModules;
          plan = plan ?? resolved.plan;
        }
      }

      // 403, not 401: the session is valid — a 401 would make the api-client force a sign-out loop for users who haven't created their org yet.
      if (!orgId && !claims.isPlatformAdmin && !allowNoOrg && !isOrgSetup) {
        throw new ForbiddenException("Organization not found");
      }

      req.user = {
        userId: claims.sub,
        orgId: orgId ?? "",
        branchId: claims.branchId ?? null,
        role,
        permissions: claims.permissions,
        enabledModules,
        plan,
        isPlatformAdmin: claims.isPlatformAdmin,
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
          enabledModules: organizations.enabledModules,
        })
        .from(organizationMembers)
        .innerJoin(
          organizations,
          eq(organizations.id, organizationMembers.orgId),
        )
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
      enabledModules: member.enabledModules ?? [],
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
      enabledModules: resolved.enabledModules,
      plan: resolved.plan,
      isPlatformAdmin: false,
      isOrgOwner: resolved.isOwner,
      sessionId: `pat:${matchedTokenId}`,
    };
  }
}
