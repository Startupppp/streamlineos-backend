import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { eq } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import { IS_PUBLIC } from "./public.decorator";
import type { BackendClaims, CurrentUserContext } from "./backend-claims";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { organizationMembers, organizations, subscriptions, userApiTokens, users } from "../../db/schema";

function extractClaims(payload: JWTPayload): BackendClaims {
  return {
    sub: typeof payload.sub === "string" ? payload.sub : "",
    orgId: typeof payload["orgId"] === "string" && payload["orgId"] !== "" ? payload["orgId"] : null,
    branchId: typeof payload["branchId"] === "number" ? payload["branchId"] : null,
    role: typeof payload["role"] === "string" ? payload["role"] : "",
    permissions: Array.isArray(payload["permissions"])
      ? payload["permissions"].filter((x): x is string => typeof x === "string")
      : [],
    enabledModules: Array.isArray(payload["enabledModules"])
      ? payload["enabledModules"].filter((x): x is string => typeof x === "string")
      : [],
    plan: typeof payload["plan"] === "string" ? payload["plan"] : null,
    isPlatformAdmin: payload["isPlatformAdmin"] === true,
    isOrgOwner: payload["isOrgOwner"] === true,
    sessionId: typeof payload["sessionId"] === "string" ? payload["sessionId"] : "",
  };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: CurrentUserContext }>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Unauthorized");
    }
    const token = header.slice("Bearer ".length).trim();
    const secret = process.env.BACKEND_JWT_SECRET;
    if (!secret) throw new UnauthorizedException("Unauthorized");

    let claims: BackendClaims | null = null;
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
      claims = extractClaims(payload);
    } catch {
      // JWT verification failed — fall through to PAT check
    }

    if (claims !== null) {
      if (!claims.sub || !claims.orgId) {
        throw new UnauthorizedException("Organization not found");
      }

      req.user = {
        userId: claims.sub,
        orgId: claims.orgId,
        branchId: claims.branchId ?? null,
        role: claims.role,
        permissions: claims.permissions ?? [],
        enabledModules: claims.enabledModules ?? [],
        plan: claims.plan ?? null,
        isPlatformAdmin: claims.isPlatformAdmin === true,
        isOrgOwner: claims.isOrgOwner === true,
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

  private async tryPatAuth(rawToken: string): Promise<CurrentUserContext | null> {
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

    const [user, member] = await Promise.all([
      this.db.query.users.findFirst({
        where: eq(users.id, matchedUserId),
        columns: { id: true, branchId: true, role: true },
      }),
      this.db.query.organizationMembers.findFirst({
        where: eq(organizationMembers.userId, matchedUserId),
        orderBy: (t, { desc }) => [desc(t.joinedAt)],
        columns: { orgId: true, role: true, isOwner: true },
      }),
    ]);

    if (!user || !member) return null;

    const [org, subscription] = await Promise.all([
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, member.orgId),
        columns: { enabledModules: true },
      }),
      this.db
        .select({ plan: subscriptions.plan })
        .from(subscriptions)
        .where(eq(subscriptions.orgId, member.orgId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    return {
      userId: matchedUserId,
      orgId: member.orgId,
      branchId: user.branchId ?? null,
      role: member.role,
      permissions: [],
      enabledModules: org?.enabledModules ?? [],
      plan: subscription?.plan ?? null,
      isPlatformAdmin: false,
      isOrgOwner: member.isOwner,
      sessionId: `pat:${matchedTokenId}`,
    };
  }
}
