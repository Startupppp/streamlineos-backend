import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ORG_MEMBER_ROLES } from "../../common/rbac/org-roles";
import { seedSystemRolesForOrg } from "../rbac/seed-system-roles";
import {
  DEFAULT_SKIP_MODULES,
  provisionOrgModules,
} from "../../common/org/provision-org-modules";
import { EntitlementsService } from "../access/entitlements.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  organizationMembers,
  organizations,
  subscriptions,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { runWithTenantContext, withTenant } from "../../common/tenant";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { SessionsService } from "../sessions/sessions.service";
import { AuthTokensService } from "./auth-tokens.service";
import { addDays } from "date-fns";
import type { RegisterInput } from "./dto/auth.schemas";
import {
  getTrialDays,
  TRIAL_PLAN,
} from "../billing/core/plan-entitlements.constants";
import { regionForNewOrg } from "../../common/region/region-registry";

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 50) +
    "-" +
    Date.now().toString(36)
  );
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sessions: SessionsService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly authTokens: AuthTokensService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async register(input: RegisterInput): Promise<{ success: true }> {
    const normalizedEmail = input.email.toLowerCase().trim();

    const existing = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
      columns: { id: true },
    });

    if (existing) return { success: true };

    const userId = randomUUID();
    const orgId = randomUUID();

    await withTenant(this.db, { orgId, audience: "INTERNAL" }, async (tx) => {
      const seqRows = await tx.execute(
        sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
      );

      const ownerMembershipId = Number(seqRows[0]?.id);

      if (!Number.isInteger(ownerMembershipId))
        throw new Error("Failed to allocate owner membership id");

      await tx.insert(organizations).values({
        id: orgId,
        region: regionForNewOrg(),
        ownerMembershipId,
        name: input.companyName,
        slug: slugify(input.companyName),
      });

      await tx.insert(users).values({
        id: userId,
        isActive: true,
        email: normalizedEmail,
        lastActiveOrgId: orgId,
        emailVerified: new Date(),
        firstName: input.firstName,
        lastName: input.lastName ?? "",
        name: input.lastName
          ? `${input.firstName} ${input.lastName}`
          : input.firstName,
      });

      await tx.insert(organizationMembers).values({
        orgId,
        userId,
        isOwner: true,
        id: ownerMembershipId,
        role: ORG_MEMBER_ROLES.OWNER,
      });

      const trialDays = getTrialDays();
      await tx.insert(subscriptions).values({
        orgId,
        plan: TRIAL_PLAN,
        status: "TRIAL",
        trialEndsAt: addDays(new Date(), trialDays),
        currentPeriodStart: new Date(),
        currentPeriodEnd: addDays(new Date(), trialDays),
      });
    });

    await withTenant(this.db, { orgId, audience: "INTERNAL" }, async (tx) =>
      runWithTenantContext({ orgId, audience: "INTERNAL", tx }, async () => {
        await seedSystemRolesForOrg(this.db, orgId);
        await provisionOrgModules(tx, orgId, DEFAULT_SKIP_MODULES, userId);
      }),
    );

    this.audit.log({
      action: "user.registered",
      userId,
      orgId,
      metadata: { email: normalizedEmail, companyName: input.companyName },
    });

    return { success: true };
  }

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

  async getSessionData(userId: string): Promise<{
    userId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    name: string | null;
    image: string | null;
    role: string | null;
    isActive: boolean;
    branchId: string | null;
    orgId: string | null;
    isOrgOwner: boolean;
    enabledModules: string[];
    orgOnboardingCompletedAt: string | null;
    userOnboardingCompletedAt: string | null;
    plan: string | null;
    organizationAccess: "active" | "suspended" | "none";
    suspendedOrganizationName: string | null;
  }> {
    return this.cache.cached(
      CACHE_KEYS.userSession(userId),
      async () => {
        const user = await this.db.query.users
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
              branchId: true,
              onboardingCompletedAt: true,
              lastActiveOrgId: true,
            },
          })
          .catch(() => {
            throw new HttpException(
              "Service temporarily unavailable",
              HttpStatus.SERVICE_UNAVAILABLE,
            );
          });

        if (!user) throw new NotFoundException("User not found");

        const membership = await this.authTokens.resolveActiveMembership(
          userId,
          user.lastActiveOrgId ?? null,
          { honorSuspendedPreference: true },
        );
        const suspendedMembership = membership
          ? null
          : await this.authTokens.resolveSuspendedMembership(
              userId,
              user.lastActiveOrgId ?? null,
            );

        let enabledModules: string[] = [];
        let orgOnboardingCompletedAt: string | null = null;
        let plan: string | null = null;

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
          branchId: user.branchId ?? null,
          orgId: resolvedOrgId,
          isOrgOwner,
          enabledModules,
          orgOnboardingCompletedAt,
          userOnboardingCompletedAt:
            user.onboardingCompletedAt?.toISOString() ?? null,
          plan,
          organizationAccess: membership
            ? "active"
            : suspendedMembership
              ? "suspended"
              : "none",
          suspendedOrganizationName: suspendedMembership?.orgName ?? null,
        };
      },
      60,
    );
  }
}
