import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { decodeJwt } from "jose";
import { PORTAL_AUDIENCE } from "../portal-auth/portal-claims";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import type { Redis } from "@upstash/redis";
import { IS_PUBLIC } from "./public.decorator";
import { ALLOW_NO_ORG_KEY } from "./allow-no-org.decorator";
import {
  type BackendClaims,
  type CurrentUserContext,
} from "./backend-claims";
import {
  ACCOUNT_ONLY_PRINCIPAL,
  humanSessionPrincipal,
  personalTokenPrincipal,
  type Principal,
} from "./principal";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { withIdentity } from "../tenant/with-identity";
import { REDIS } from "../../common/cache/cache.service";
import {
  hashApiToken,
  isModernApiToken,
  legacyApiTokenPrefix,
} from "./api-token-hash";
import { accountOrganizationIndex, organizationMembers, organizations, userApiTokens, userSessions } from "../../db/schema";
import { MembershipStateService } from "./membership-state.service";
import { JwtKeyringService } from "./jwt-keyring.service";

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

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private readonly orgCtxCache = new Map<string, OrgContextEntry>();
  private readonly revocationCache = new Map<string, number>();

  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis | null,
    private readonly membership: MembershipStateService,
    private readonly keyring: JwtKeyringService,
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
    const verified = await this.keyring.verifyToken(token);
    if (verified) {
      claims = { sub: verified.sub, orgId: verified.orgId, sessionId: verified.sessionId };
    }

    if (claims !== null) {
      if (!claims.sessionId.startsWith("pat:")) {
        const cachedOk = this.revocationCache.get(claims.sessionId);
        if (!(cachedOk && cachedOk > Date.now())) {
          let tombstone: boolean | null = null;
          let useDatabase = this.redis === null;
          if (this.redis) {
            try {
              tombstone = await this.redis.get<boolean>(
                `revoked:session:${claims.sessionId}`,
              );
            } catch (err) {
              useDatabase = true;
              this.logger.error(
                `session revocation lookup failed, falling back to the database: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          let revoked = tombstone === true;
          let resolved = true;
          if (useDatabase) {
            const stored = await this.isRevokedInDatabase(claims.sessionId);
            revoked = stored === true;
            resolved = stored !== null;
          }

          if (revoked) {
            this.revocationCache.delete(claims.sessionId);
            throw new UnauthorizedException("Session has been revoked");
          }
          if (resolved) {
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

      const accountActive = await this.membership.isAccountActive(claims.sub);
      if (!accountActive) {
        throw new UnauthorizedException("Unauthorized");
      }

      let role = "";
      let isOrgOwner = false;
      let resolvedOrgId = orgId ?? "";
      let principal: Principal = ACCOUNT_ONLY_PRINCIPAL;

      if (orgId) {
        const state = await this.membership.resolve(claims.sub, orgId);
        if (!state.active || state.membershipId === null) {
          if (!allowNoOrg) {
            // The login is still valid; only this organization membership is
            // no longer usable. A 401 would incorrectly sign the person out of
            // every other organization and can send a stale browser session
            // back through first-time organization setup.
            throw new ForbiddenException({
              code: "ORG_MEMBERSHIP_INACTIVE",
              message:
                "Your access to this organization is no longer active. Refresh to continue with an available organization.",
            });
          }
          resolvedOrgId = "";
        } else {
          role = state.role;
          isOrgOwner = state.isOwner;
          principal = humanSessionPrincipal(state.membershipId, state.isOwner);
        }
      }

      req.user = {
        userId: claims.sub,
        orgId: resolvedOrgId,
        role,
        isOrgOwner,
        sessionId: claims.sessionId,
        tokenScopes: null,
        principal,
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
   * Redis holds the revocation tombstone, but it is a cache, not the record.
   * When it is missing or erroring, `user_sessions.is_revoked` is the durable
   * answer — so an Upstash outage costs a database read, not a 500 on every
   * authenticated request and not a silently unenforced revocation. Only a
   * double failure returns null, and the caller then treats the session as live.
   */
  private async isRevokedInDatabase(sessionId: string): Promise<boolean | null> {
    try {
      const rows = await this.db
        .select({ isRevoked: userSessions.isRevoked })
        .from(userSessions)
        .where(eq(userSessions.id, sessionId))
        .limit(1);
      return rows[0]?.isRevoked ?? false;
    } catch (err) {
      this.logger.error(
        `database revocation fallback failed, treating session as live: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
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
    const rows = await withIdentity(this.db, userId, (tx) =>
      tx
        .select({
          orgId: organizationMembers.orgId,
          role: organizationMembers.role,
          isOwner: organizationMembers.isOwner,
        })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
        .leftJoin(
          accountOrganizationIndex,
          and(
            eq(accountOrganizationIndex.userId, organizationMembers.userId),
            eq(accountOrganizationIndex.orgId, organizationMembers.orgId),
          ),
        )
        .where(
          and(
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.status, "ACTIVE"),
            eq(organizations.status, "ACTIVE"),
            isNull(organizations.deletedAt),
          ),
        )
        .orderBy(
          sql`${accountOrganizationIndex.lastActivatedAt} DESC NULLS LAST`,
          desc(organizationMembers.joinedAt),
          desc(organizationMembers.id),
        )
        .limit(1),
    );

    const member = rows[0];
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

    const accountActive = await this.membership.isAccountActive(matched.userId);
    if (!accountActive) return null;

    const resolved = await this.resolveOrgContext(matched.userId);
    if (!resolved) return null;

    const state = await this.membership.resolve(matched.userId, resolved.orgId);
    if (!state.active || state.membershipId === null) return null;

    void this.db
      .update(userApiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(userApiTokens.id, matched.id))
      .catch(() => undefined);

    return {
      userId: matched.userId,
      orgId: resolved.orgId,
      role: state.role,
      isOrgOwner: state.isOwner,
      sessionId: `pat:${matched.id}`,
      tokenScopes: matched.scopes,
      principal: personalTokenPrincipal(
        state.membershipId,
        state.isOwner,
        matched.id,
        matched.scopes,
      ),
    };
  }

  private async findApiToken(
    rawToken: string,
  ): Promise<{ id: string; userId: string; scopes: string[] } | null> {
    const now = new Date();
    const liveToken = and(
      isNull(userApiTokens.revokedAt),
      gt(userApiTokens.expiresAt, now),
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
