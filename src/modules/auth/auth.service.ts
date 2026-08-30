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
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  accountOrganizationIndex,
  organizationMembers,
  organizations,
  subscriptions,
  users,
  roles,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { runWithTenantContext, withTenant } from "../../common/tenant";
import { withIdentity } from "../../common/tenant/with-identity";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { seedDemoDataset } from "../onboarding-activation/seed-demo-dataset";
import { SessionsService } from "../sessions/sessions.service";
import { AuthTokensService } from "./auth-tokens.service";
import { addDays } from "date-fns";
import type { RegisterInput } from "./dto/auth.schemas";
import {
  getTrialDays,
  TRIAL_PLAN,
} from "../billing/core/plan-entitlements.constants";
import { placeOrganization } from "../../common/region/placement-lookup";
import { LEGACY_CELL_ID } from "../../common/region/placement";
import { chooseRegionForNewOrg } from "../../common/region/cell-admission";

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
      columns: { id: true, isActive: true, lastActiveOrgId: true },
    });

    if (existing) {
      await this.resumeProvisioning(existing);
      return { success: true };
    }

    const userId = randomUUID();
    const orgId = randomUUID();

    const region = (await chooseRegionForNewOrg(this.db, { organizationId: orgId })).region;
    await placeOrganization(this.db, { orgId, region });

    await withTenant(this.db, { orgId, audience: "INTERNAL" }, async (tx) => {
      const seqRows = await tx.execute(
        sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
      );

      const ownerMembershipId = Number(seqRows[0]?.id);

      if (!Number.isInteger(ownerMembershipId))
        throw new Error("Failed to allocate owner membership id");

      await tx.insert(organizations).values({
        id: orgId,
        region,
        ownerMembershipId,
        name: input.companyName,
        slug: slugify(input.companyName),
      });

      await tx.insert(users).values({
        id: userId,
        /*
          Closed until provisioning finishes, then opened at the end of
          `register`. There is otherwise a window where the row exists and the
          workspace has no roles in it, and a sign-in landing in that window
          reaches a workspace that renders nothing. If provisioning throws the
          door simply never opens, which is a state somebody can retry out of.
        */
        isActive: false,
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

    await this.provisionWorkspace(orgId, userId);

    await withIdentity(this.db, userId, (tx) =>
      tx
        .insert(accountOrganizationIndex)
        .values({
          userId,
          orgId,
          cellId: LEGACY_CELL_ID,
          region,
          organizationName: input.companyName,
          organizationSlug: slugify(input.companyName),
          membershipRole: ORG_MEMBER_ROLES.OWNER,
          membershipStatus: "ACTIVE",
          organizationStatus: "ACTIVE",
          joinedAt: new Date(),
          lastActivatedAt: new Date(),
          projectedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [accountOrganizationIndex.userId, accountOrganizationIndex.orgId],
          set: { lastActivatedAt: new Date() },
        }),
    );

    await this.openAccount(userId);

    this.audit.log({
      action: "user.registered",
      userId,
      orgId,
      metadata: { email: normalizedEmail, companyName: input.companyName },
    });

    return { success: true };
  }

  /**
   * Everything a new workspace needs before anybody can look at it.
   *
   * Roles and modules make it usable; the demo dataset is what its first screen
   * shows, and all three go in one tenant transaction so a signup gets the whole
   * of provisioning or none of it.
   */
  private async provisionWorkspace(orgId: string, userId: string): Promise<void> {
    await withTenant(this.db, { orgId, audience: "INTERNAL" }, async (tx) =>
      runWithTenantContext({ orgId, audience: "INTERNAL", tx }, async () => {
        await seedSystemRolesForOrg(this.db, orgId);
        await provisionOrgModules(tx, orgId, DEFAULT_SKIP_MODULES, userId);
        await seedDemoDataset(tx, orgId, userId);
      }),
    );
  }

  /**
   * The last step, deliberately: the account is created closed and opens only
   * once provisioning has finished, so no sign-in can land in a workspace that
   * has no roles in it yet.
   */
  private async openAccount(userId: string): Promise<void> {
    await this.db.update(users).set({ isActive: true }).where(eq(users.id, userId));
    await this.cache.del(CACHE_KEYS.userSession(userId));
  }

  /**
   * Finish a registration that did not finish, without starting a second one.
   *
   * Returning success for an existing email is right for somebody who already
   * has a workspace and wrong for somebody whose provisioning threw halfway:
   * they hold a closed account, an organisation with no roles in it, and no way
   * to reach either. Retrying the signup is the obvious thing to do, and it did
   * nothing. The system-role ladder is the marker for "provisioning finished",
   * so its absence is what makes this resume rather than a flag somebody has to
   * remember to clear.
   */
  private async resumeProvisioning(existing: {
    id: string;
    isActive: boolean;
    lastActiveOrgId: string | null;
  }): Promise<void> {
    if (existing.isActive) return;

    const orgId = existing.lastActiveOrgId;
    if (!orgId) return;

    const [ladder] = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.isSystem, true)))
      .limit(1);

    if (ladder) return;

    await this.provisionWorkspace(orgId, existing.id);
    await this.openAccount(existing.id);
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

  async getSessionData(userId: string): Promise<{
    userId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    name: string | null;
    image: string | null;
    role: string | null;
    isActive: boolean;
    orgId: string | null;
    cellId: string | null;
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

        const membership = await this.authTokens.resolveActiveMembership(
          userId,
          preferredOrgId,
          { honorSuspendedPreference: true },
        );
        const suspendedMembership = membership
          ? null
          : await this.authTokens.resolveSuspendedMembership(
              userId,
              preferredOrgId,
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
          orgId: resolvedOrgId,
          cellId: resolvedOrgId ? (preferred?.cellId ?? null) : null,
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
