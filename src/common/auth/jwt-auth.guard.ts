import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { decodeJwt } from "jose";
import { PORTAL_AUDIENCE } from "../portal-auth/portal-claims";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import type { Redis } from "@upstash/redis";
import { IS_PUBLIC } from "./public.decorator";
import { ALLOW_NO_ORG_KEY } from "./allow-no-org.decorator";
import { ALLOW_AGENT_TOKEN } from "./allow-agent-token.decorator";
import {
  isAgentTokenCredential,
  resolveAgentToken,
} from "./agent-token-resolution";
import { type BackendClaims, type CurrentUserContext } from "./backend-claims";
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
import {
  accountOrganizationIndex,
  impersonationSessions,
  organizationMembers,
  organizations,
  userApiTokens,
  userSessions,
} from "../../db/schema";
import {
  MembershipStateService,
  type MembershipState,
} from "./membership-state.service";
import { JwtKeyringService } from "./jwt-keyring.service";
import { type AuthContext } from "./auth-context";
import { AuthContextFactory } from "./auth-context.factory";

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

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private readonly orgCtxCache = new Map<string, OrgContextEntry>();

  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis | null,
    private readonly membership: MembershipStateService,
    private readonly keyring: JwtKeyringService,
    private readonly authContexts: AuthContextFactory,
  ) {}

  private attach(
    req: Request & { user?: CurrentUserContext; authContext?: AuthContext },
    actor: CurrentUserContext,
    membership?: MembershipState,
  ): void {
    req.user = actor;
    req.authContext = this.authContexts.create(actor, membership);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context
      .switchToHttp()
      .getRequest<
        Request & { user?: CurrentUserContext; authContext?: AuthContext }
      >();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Unauthorized");
    }
    const token = header.slice("Bearer ".length).trim();

    /**
     * An agent token, on a surface that has declared it accepts one.
     *
     * Handled before the JWT and PAT paths because it is neither: a `slos_`
     * credential lives in `agent_tokens`, hashed by a different function from
     * the `user_api_tokens` rows `tryPatAuth` reads, so both paths below would
     * fail it and it would fall out of the bottom as a 401. That 401 was
     * CRM-P1-16 — the CRM MCP settings page mints exactly this credential for a
     * server that could not accept it.
     *
     * Nothing widens for a route that has not opted in: without
     * `@AllowAgentToken()` the credential is refused here, which is the same
     * answer it gets today, one step earlier.
     *
     * Attached through `attach`, like every other caller, so the request also
     * carries an `authContext`: `PermissionGuard` authorizes against that, and a
     * request with only `req.user` would be refused on every gated route.
     */
    if (isAgentTokenCredential(token)) {
      const allowsAgentToken = this.reflector.getAllAndOverride<boolean>(
        ALLOW_AGENT_TOKEN,
        [context.getHandler(), context.getClass()],
      );
      if (!allowsAgentToken) throw new UnauthorizedException("Unauthorized");

      const agentCtx = await resolveAgentToken(this.db, this.membership, token);
      if (!agentCtx) throw new UnauthorizedException("Unauthorized");
      this.attach(req, agentCtx);
      return true;
    }

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
      claims = {
        sub: verified.sub,
        orgId: verified.orgId,
        sessionId: verified.sessionId,
        impersonation: verified.impersonation,
      };
    }

    if (claims !== null) {
      if (!claims.sessionId.startsWith("pat:")) {
        if (claims.impersonation) {
          const impersonated = await this.isImpersonationSessionRevoked(
            claims.impersonation.impersonationSessionId,
          );
          if (impersonated !== false)
            throw new UnauthorizedException("Impersonation session has been revoked");
        } else {
          // Every request re-reads the tombstone. A positive-result cache used to sit here
          // and it made revocation take effect up to its TTL later, on a per-process basis.
          let tombstone: boolean | null = null;
          let redisErrored = false;
          if (this.redis) {
            try {
              tombstone = await this.redis.get<boolean>(
                `revoked:session:${claims.sessionId}`,
              );
            } catch (err) {
              redisErrored = true;
              this.logger.error(
                `session revocation lookup failed, falling back to the database: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          // Positive tombstone: session is durably revoked — deny without a DB read (hot path).
          if (tombstone === true)
            throw new UnauthorizedException("Session has been revoked");

          // Consult the DB when: Redis is absent, Redis errored, or tombstone was a cache miss (null).
          const needsDatabase =
            this.redis === null || redisErrored || tombstone === null;
          if (needsDatabase) {
            const dbResult = await this.isRevokedInDatabase(claims.sessionId);
            if (dbResult === null) {
              // Both revocation authorities failed — fail closed rather than admit a possibly-revoked session.
              this.logger.error(
                `session revocation double-failure for sessionId=${claims.sessionId}: both Redis and the database were unavailable; denying to fail closed`,
              );
              throw new UnauthorizedException(
                "Session revocation check unavailable",
              );
            }
            if (dbResult)
              throw new UnauthorizedException("Session has been revoked");
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
      let membership: MembershipState | undefined;

      if (orgId) {
        const state = await this.membership.resolve(claims.sub, orgId);
        membership = state;
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

      this.attach(
        req,
        {
          userId: claims.sub,
          orgId: resolvedOrgId,
          role,
          isOrgOwner,
          sessionId: claims.sessionId,
          tokenScopes: null,
          principal,
          impersonation: claims.impersonation,
        },
        membership,
      );
      return true;
    }

    const personalToken = await this.tryPatAuth(token);
    if (personalToken) {
      this.attach(req, personalToken.actor, personalToken.membership);
      return true;
    }

    throw new UnauthorizedException("Unauthorized");
  }

  private async isImpersonationSessionRevoked(
    impersonationSessionId: string,
  ): Promise<boolean> {
    try {
      if (this.redis) {
        const tombstone = await this.redis.get<boolean>(
          `revoked:impersonation:${impersonationSessionId}`,
        );
        if (tombstone === true) return true;
      }
      const rows = await this.db
        .select({ isRevoked: impersonationSessions.isRevoked })
        .from(impersonationSessions)
        .where(eq(impersonationSessions.id, impersonationSessionId))
        .limit(1);
      return rows[0]?.isRevoked ?? true;
    } catch (err) {
      this.logger.error(
        `impersonation session revocation check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
  }

  private async isRevokedInDatabase(
    sessionId: string,
  ): Promise<boolean | null> {
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
      this.orgCtxCache.set(userId, {
        value: result,
        expiresAt: Date.now() + ORG_CTX_TTL_MS,
      });
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
        .innerJoin(
          organizations,
          eq(organizations.id, organizationMembers.orgId),
        )
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
  ): Promise<{ actor: CurrentUserContext; membership: MembershipState } | null> {
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
      actor: {
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
      },
      membership: state,
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
