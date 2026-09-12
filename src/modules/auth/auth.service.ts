import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { EntitlementsService } from "../access/entitlements.service";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  accountOrganizationIndex,
  accounts,
  subscriptions,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { withIdentity } from "../../common/tenant/with-identity";
import {
  runInTenantTransaction,
} from "../../common/tenant/run-in-tenant-transaction";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { SessionsService } from "../sessions/sessions.service";
import { AuthMembershipResolverService } from "./auth-membership-resolver.service";
import { AuthAnalyticsService } from "./auth-analytics.service";
import type { GoogleOAuthInput } from "./dto/auth.schemas";
import type { AuthSessionData } from "./dto/auth-response.schemas";
import { type EffectivePlan } from "../billing/core/plan-entitlements.constants";
import { isPlatformAdmin } from "../../common/rbac/platform-operators";

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sessions: SessionsService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly membershipResolver: AuthMembershipResolverService,
    private readonly analytics: AuthAnalyticsService,
  ) {}

  async logout(sessionId: string, userId: string): Promise<void> {
    await this.sessions.revokeCurrent(userId, sessionId);
    this.audit.log({ action: "auth.logout", userId });
  }

  async logoutAll(userId: string, exceptSessionId?: string): Promise<void> {
    await (exceptSessionId
      ? this.sessions.revokeAllOthers(userId, exceptSessionId)
      : this.sessions.revokeAllForUser(userId));
    this.audit.log({ action: "auth.logout_all", userId });
  }

  async googleOAuth(
    input: GoogleOAuthInput,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<{ userId: string; isNewUser: boolean; sessionId: string }> {
    const normalizedEmail = input.email.toLowerCase().trim();

    const existingAccount = await this.db.query.accounts.findFirst({
      where: and(
        eq(accounts.provider, "google"),
        eq(accounts.providerAccountId, input.googleId),
      ),
      columns: { userId: true },
    });

    if (existingAccount) {
      const accountUser = await this.db.query.users.findFirst({
        where: eq(users.id, existingAccount.userId),
        columns: { isActive: true, deletedAt: true },
      });
      if (
        !accountUser ||
        !accountUser.isActive ||
        accountUser.deletedAt !== null
      ) {
        void this.analytics.logLoginEvent(
          existingAccount.userId,
          null,
          "google_oauth.login",
          false,
          "account_inactive",
          context,
        );
        throw new UnauthorizedException("Authentication failed");
      }
      const sessionId = await this.membershipResolver.createLoginSession(
        existingAccount.userId,
        context,
      );
      void this.analytics.logLoginEvent(
        existingAccount.userId,
        null,
        "google_oauth.login",
        true,
        null,
        context,
      );
      return { userId: existingAccount.userId, isNewUser: false, sessionId };
    }

    const existingUser = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
      columns: {
        id: true,
        emailVerified: true,
        isActive: true,
        deletedAt: true,
      },
    });

    if (existingUser) {
      if (!existingUser.isActive || existingUser.deletedAt !== null) {
        void this.analytics.logLoginEvent(
          existingUser.id,
          null,
          "google_oauth.login",
          false,
          "account_inactive",
          context,
        );
        throw new UnauthorizedException("Authentication failed");
      }
      await this.db
        .insert(accounts)
        .values({
          userId: existingUser.id,
          type: "oauth",
          provider: "google",
          providerAccountId: input.googleId,
        })
        .onConflictDoNothing();

      if (!existingUser.emailVerified) {
        await this.db
          .update(users)
          .set({ emailVerified: new Date() })
          .where(eq(users.id, existingUser.id));
      }

      const sessionId = await this.membershipResolver.createLoginSession(
        existingUser.id,
        context,
      );
      void this.analytics.logLoginEvent(
        existingUser.id,
        null,
        "google_oauth.login",
        true,
        null,
        context,
      );
      return { userId: existingUser.id, isNewUser: false, sessionId };
    }

    const newUserId = randomUUID();
    const rawName = (input.name ?? normalizedEmail.split("@")[0]).trim();
    const spaceIdx = rawName.indexOf(" ");
    const firstName = spaceIdx === -1 ? rawName : rawName.slice(0, spaceIdx);
    const lastName = spaceIdx === -1 ? "" : rawName.slice(spaceIdx + 1).trim();

    const resolvedUserId = await this.db.transaction(async (tx) => {
      const insertResult = await tx
        .insert(users)
        .values({
          id: newUserId,
          email: normalizedEmail,
          name: rawName,
          firstName,
          lastName,
          image: input.image || null,
          isActive: true,
          emailVerified: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: users.id });

      if (insertResult[0]) {
        await tx.insert(accounts).values({
          userId: insertResult[0].id,
          type: "oauth",
          provider: "google",
          providerAccountId: input.googleId,
        });
        return insertResult[0].id;
      }

      const raced = await tx.query.users.findFirst({
        where: sql`lower(${users.email}) = ${normalizedEmail}`,
        columns: { id: true },
      });
      if (!raced) throw new Error("Concurrent user creation conflict unresolvable");
      await tx
        .insert(accounts)
        .values({
          userId: raced.id,
          type: "oauth",
          provider: "google",
          providerAccountId: input.googleId,
        })
        .onConflictDoNothing();
      return raced.id;
    });

    this.audit.log({
      action: "user.registered",
      userId: resolvedUserId,
      metadata: { email: normalizedEmail, provider: "google" },
    });

    const sessionId = await this.membershipResolver.createLoginSession(
      resolvedUserId,
      context,
    );
    void this.analytics.logLoginEvent(
      resolvedUserId,
      null,
      "google_oauth.register",
      true,
      null,
      context,
    );
    return { userId: resolvedUserId, isNewUser: true, sessionId };
  }

  private async resolvePreferredOrg(
    userId: string,
  ): Promise<{ orgId: string; cellId: string } | null> {
    const rows = await withIdentity(this.db, userId, (tx) =>
      tx
        .select({
          orgId: accountOrganizationIndex.orgId,
          cellId: accountOrganizationIndex.cellId,
        })
        .from(accountOrganizationIndex)
        .where(eq(accountOrganizationIndex.userId, userId))
        .orderBy(
          sql`${accountOrganizationIndex.lastActivatedAt} DESC NULLS LAST`,
          desc(accountOrganizationIndex.joinedAt),
        )
        .limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    return { orgId: row.orgId, cellId: row.cellId };
  }

  async getSessionData(userId: string): Promise<AuthSessionData> {
    return this.cache.cached(
      CACHE_KEYS.userSession(userId),
      async () => {
        const [user, preferred] = await Promise.all([
          this.db.query.users
            .findFirst({
              where: eq(users.id, userId),
              columns: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                name: true,
                image: true,
                isActive: true,
                onboardingCompletedAt: true,
                lastActiveOrgId: true,
              },
            })
            .catch(() => {
              throw new HttpException(
                "Service temporarily unavailable",
                HttpStatus.SERVICE_UNAVAILABLE,
              );
            }),
          this.resolvePreferredOrg(userId).catch(() => null),
        ]);

        if (!user) throw new NotFoundException("User not found");

        const preferredOrgId = preferred?.orgId ?? user.lastActiveOrgId ?? null;

        const membership =
          await this.membershipResolver.resolveActiveMembership(
            userId,
            preferredOrgId,
            { honorSuspendedPreference: true },
          );
        const suspendedMembership = membership
          ? null
          : await this.membershipResolver.resolveSuspendedMembership(
              userId,
              preferredOrgId,
            );

        let enabledModules: string[] = [];
        let orgOnboardingCompletedAt: string | null = null;
        let plan: EffectivePlan | null = null;

        const resolvedOrgId = membership?.orgId ?? null;
        const isOrgOwner = membership?.isOwner ?? false;

        if (membership) {
          orgOnboardingCompletedAt =
            membership.orgOnboardingCompletedAt?.toISOString() ?? null;

          await runInTenantTransaction(
            this.db,
            async (tx) => {
              const [sub, moduleStatuses] = await Promise.all([
                tx.query.subscriptions.findFirst({
                  where: eq(subscriptions.orgId, membership.orgId),
                  columns: { plan: true, status: true },
                }),
                this.entitlements.listModules(membership.orgId).catch(() => []),
              ]);

              if (sub) {
                plan =
                  sub.status === "ACTIVE" || sub.status === "TRIAL"
                    ? sub.plan
                    : "FREE";
              }
              enabledModules = moduleStatuses
                .filter((m) => m.enabled)
                .map((m) => m.moduleKey);
            },
            { orgId: membership.orgId },
          );
        }

        return {
          userId: user.id,
          email: user.email,
          firstName: user.firstName ?? null,
          lastName: user.lastName ?? null,
          name: user.name ?? null,
          image: user.image ?? null,
          role: membership?.role ?? null,
          isActive: user.isActive,
          orgId: resolvedOrgId,
          cellId: resolvedOrgId ? (preferred?.cellId ?? null) : null,
          isOrgOwner,
          enabledModules,
          orgOnboardingCompletedAt,
          userOnboardingCompletedAt:
            membership?.memberOnboardingCompletedAt?.toISOString() ?? null,
          plan,
          organizationAccess: membership
            ? "active"
            : suspendedMembership
              ? "suspended"
              : "none",
          suspendedOrganizationName: suspendedMembership?.orgName ?? null,
          isPlatformAdmin: isPlatformAdmin(userId),
        };
      },
      60,
    );
  }
}
