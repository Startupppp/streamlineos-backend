import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  users,
  subscriptions,
  organizations,
  magicLinkTokens,
  organizationMembers,
} from "../../../db/schema";
import { addDays, addMinutes } from "date-fns";
import { type Db } from "../../../db/drizzle.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type SetupInput } from "./dto/org.schemas";
import { OnboardingSessionService } from "../../hr/onboarding/flow/onboarding-session.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { logger } from "../../../common/logger/logger.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { bustMembershipStatusCache } from "../../../common/auth/membership-state.service";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { bumpPermissionsVersion } from "../../../common/rbac/access-invalidate";
import {
  runInNewTenantTransaction,
  runInTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import type { TenantTx } from "../../../common/tenant/with-tenant";
import { withIdentity } from "../../../common/tenant/with-identity";
import { runOutsideTenantContext } from "../../../common/tenant/tenant-context";
import {
  DEFAULT_SKIP_MODULES,
  provisionOrgModules,
} from "../../../common/org/provision-org-modules";
import { provisionEmployeeSelfService } from "../../../common/org/provision-employee-self-service";
import { seedSystemRolesForOrg } from "../../rbac/seed-system-roles";
import { ModuleChecklistService } from "../../hr/onboarding/flow/module-checklist.service";
import {
  getTrialDays,
  TRIAL_PLAN,
} from "../../billing/core/plan-entitlements.constants";
import { placeOrganization } from "../../../common/region/placement-lookup";
import { regionForNewOrg } from "../../../common/region/region-registry";

export { DEFAULT_SKIP_MODULES, provisionOrgModules };

type SetupMembership = {
  id: number;
  orgId: string;
  existingOrgId: string | null;
  orgName: string | null;
  orgStatus: string | null;
  orgDeletedAt: Date | null;
  status: "INVITED" | "ACTIVE" | "SUSPENDED" | "LEFT";
  isOwner: boolean;
};

type SetupTarget = {
  orgId: string;
  isOwner: boolean;
};

@Injectable()
export class OrgSetupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly sessions: OnboardingSessionService,
    private readonly checklists: ModuleChecklistService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  private async sendWelcome(orgId: string, userId: string): Promise<void> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { email: true, name: true, firstName: true },
    });
    if (!user?.email) return;
    const name = user.name?.trim() || user.firstName?.trim() || user.email;
    await this.dispatch.emit({
      eventKey: "organization.setup.completed",
      orgId,
      actorUserId: userId,
      notifySelf: true,
      targetUserIds: [userId],
      entityType: "organization",
      entityId: orgId,
      title: "Organization setup complete",
      message: `Welcome to ${name}. Your organization is ready.`,
      link: "/dashboard",
      variables: { userName: name, email: user.email },
    });
  }

  private schedulePostSetupWork(input: {
    orgId: string;
    userId: string;
    moduleKeys: readonly string[];
    sessionAction: "complete" | "skip";
    skipReason?: string;
    sendWelcome?: boolean;
  }): void {
    setImmediate(() => {
      void runOutsideTenantContext(() => this.runPostSetupWork(input)).catch(
        (error: unknown) => {
          logger.error("Organization post-setup work failed", {
            orgId: input.orgId,
            userId: input.userId,
            error,
          });
        },
      );
    });
  }

  private async runPostSetupWork(input: {
    orgId: string;
    userId: string;
    moduleKeys: readonly string[];
    sessionAction: "complete" | "skip";
    skipReason?: string;
    sendWelcome?: boolean;
  }): Promise<void> {
    const roleWork = runInTenantTransaction(
      this.db,
      () => seedSystemRolesForOrg(this.db, input.orgId),
      { orgId: input.orgId },
    );
    const checklistWork = runInTenantTransaction(
      this.db,
      () =>
        this.checklists.ensureChecklistsForModules(
          input.orgId,
          input.moduleKeys,
        ),
      { orgId: input.orgId },
    );
    const sessionWork =
      input.sessionAction === "complete"
        ? runInTenantTransaction(
            this.db,
            () =>
              this.sessions.completeSession(
                input.orgId,
                input.userId,
                "org_setup",
              ),
            { orgId: input.orgId },
          )
        : runInTenantTransaction(
            this.db,
            () =>
              this.sessions.skipSession(
                input.orgId,
                input.userId,
                "org_setup",
                input.skipReason,
              ),
            { orgId: input.orgId },
          );

    const work = await Promise.allSettled([
      roleWork,
      checklistWork,
      sessionWork,
      ...(input.sendWelcome ? [this.sendWelcome(input.orgId, input.userId)] : []),
    ]);

    for (const result of work) {
      if (result.status === "rejected") {
        logger.error("Organization post-setup task failed", {
          orgId: input.orgId,
          userId: input.userId,
          error: result.reason,
        });
      }
    }
  }

  private slugify(name: string): string {
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

  private async listSetupMemberships(userId: string): Promise<SetupMembership[]> {
    return withIdentity(this.db, userId, (tx) =>
      tx
        .select({
          id: organizationMembers.id,
          orgId: organizationMembers.orgId,
          existingOrgId: organizations.id,
          orgName: organizations.name,
          orgStatus: organizations.status,
          orgDeletedAt: organizations.deletedAt,
          status: organizationMembers.status,
          isOwner: organizationMembers.isOwner,
        })
        .from(organizationMembers)
        .leftJoin(
          organizations,
          eq(organizations.id, organizationMembers.orgId),
        )
        .where(eq(organizationMembers.userId, userId))
        .orderBy(desc(organizationMembers.joinedAt)),
    );
  }

  private suspendedAccessError(organizationName: string | null) {
    const displayName = organizationName?.trim() || "this organization";
    return new ForbiddenException({
      code: "ORG_MEMBERSHIP_SUSPENDED",
      message: `Your access to ${displayName} is suspended. Ask an organization admin to restore it.`,
      details: { organizationName },
    });
  }

  private async resolveCurrentSetupTarget(
    u: CurrentUserContext,
  ): Promise<SetupTarget | null> {
    if (!u.orgId) return null;

    const [membership, organization] = await Promise.all([
      this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, u.userId),
          eq(organizationMembers.orgId, u.orgId),
        ),
        columns: { status: true, isOwner: true },
      }),
      this.db.query.organizations.findFirst({
        where: and(
          eq(organizations.id, u.orgId),
          eq(organizations.status, "ACTIVE"),
          isNull(organizations.deletedAt),
        ),
        columns: { id: true, name: true },
      }),
    ]);

    if (!organization || !membership) return null;
    if (membership.status === "ACTIVE") {
      return { orgId: organization.id, isOwner: membership.isOwner };
    }
    if (membership.status === "SUSPENDED") {
      throw this.suspendedAccessError(organization.name);
    }
    return null;
  }

  private resolveExistingSetupTarget(
    u: CurrentUserContext,
    memberships: SetupMembership[],
  ): SetupTarget | null {
    const isAvailable = (membership: SetupMembership) =>
      membership.existingOrgId !== null &&
      membership.orgStatus === "ACTIVE" &&
      membership.orgDeletedAt === null;

    const active =
      memberships.find(
        (membership) =>
          membership.orgId === u.orgId &&
          membership.status === "ACTIVE" &&
          isAvailable(membership),
      ) ??
      memberships.find(
        (membership) =>
          membership.status === "ACTIVE" && isAvailable(membership),
      );

    if (active) {
      return { orgId: active.orgId, isOwner: active.isOwner };
    }

    const suspended =
      memberships.find(
        (membership) =>
          membership.orgId === u.orgId &&
          membership.status === "SUSPENDED" &&
          isAvailable(membership),
      ) ??
      memberships.find(
        (membership) =>
          membership.status === "SUSPENDED" && isAvailable(membership),
      );

    if (suspended) {
      throw this.suspendedAccessError(suspended.orgName);
    }

    return null;
  }

  private async resolveOrCreateOrg(
    u: CurrentUserContext,
    input: Pick<SetupInput, "companyName">,
  ): Promise<SetupTarget> {
    const currentTarget = await this.resolveCurrentSetupTarget(u);
    if (currentTarget) return currentTarget;

    const memberships = await this.listSetupMemberships(u.userId);
    const existingTarget = this.resolveExistingSetupTarget(u, memberships);
    if (existingTarget) return existingTarget;

    const orphansByOrg = new Map<string, number[]>();
    for (const m of memberships) {
      if (m.existingOrgId !== null) continue;
      orphansByOrg.set(m.orgId, [...(orphansByOrg.get(m.orgId) ?? []), m.id]);
    }
    for (const [orphanOrgId, ids] of orphansByOrg) {
      try {
        await runInTenantTransaction(
          this.db,
          async (tx) => {
            await tx
              .delete(organizationMembers)
              .where(inArray(organizationMembers.id, ids));
          },
          { orgId: orphanOrgId },
        );
        await bustMembershipStatusCache(this.cache, u.userId, orphanOrgId);
      } catch (error) {
        logger.warn("Orphan membership cleanup failed", {
          userId: u.userId,
          orphanOrgId,
          error,
        });
      }
    }

    const orgId = randomUUID();
    const orgName = input.companyName?.trim() || "My Organization";
    const region = regionForNewOrg();
    await placeOrganization(this.db, { orgId, region });

    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const seqRows = await tx.execute(
        sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
      );
      const ownerMembershipId = Number(seqRows[0]?.id);
      if (!Number.isInteger(ownerMembershipId)) {
        throw new Error("Failed to allocate owner membership id");
      }
      await tx.insert(organizations).values({
        id: orgId,
        region,
        name: orgName,
        slug: this.slugify(orgName),
        ownerMembershipId,
      });
      await tx.insert(organizationMembers).values({
        id: ownerMembershipId,
        orgId,
        userId: u.userId,
        role: ORG_MEMBER_ROLES.OWNER,
        isOwner: true,
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
      await provisionEmployeeSelfService(tx, orgId);
      await bumpPermissionsVersion(tx, orgId);
    });

    this.audit.log({
      action: "org.created",
      userId: u.userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });
    return { orgId, isOwner: true };
  }

  private provisionOrgModules(
    tx: TenantTx,
    orgId: string,
    moduleKeys: readonly string[],
    enabledBy: string,
  ): Promise<void> {
    return provisionOrgModules(tx, orgId, moduleKeys, enabledBy);
  }

  async completeSetup(u: CurrentUserContext, input: SetupInput) {
    const target = await this.resolveOrCreateOrg(u, input);
    const { orgId } = target;
    if (!target.isOwner) return { success: true, orgId };

    const autoLoginToken = randomBytes(32).toString("hex");

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx
          .update(organizations)
          .set({
            industry: input.industry,
            companySize: input.companySize,
            ...(input.country ? { country: input.country } : {}),
            ...(input.timezone ? { timezone: input.timezone } : {}),
            ...(input.companyName ? { name: input.companyName } : {}),
            onboardingCompletedAt: new Date(),
          })
          .where(eq(organizations.id, orgId));

        await this.provisionOrgModules(
          tx,
          orgId,
          input.enabledModules,
          u.userId,
        );
        await provisionEmployeeSelfService(tx, orgId);

        await tx
          .update(users)
          .set({
            lastActiveOrgId: orgId,
            ...(input.phone ? { phone: input.phone } : {}),
          })
          .where(eq(users.id, u.userId));

        await tx.insert(magicLinkTokens).values({
          id: randomUUID(),
          userId: u.userId,
          tokenHash: createHash("sha256").update(autoLoginToken).digest("hex"),
          expiresAt: addMinutes(new Date(), 10),
        });
      },
      { orgId },
    );

    await this.cache.invalidate(CACHE_KEYS.userSession(u.userId));
    this.schedulePostSetupWork({
      orgId,
      userId: u.userId,
      moduleKeys: input.enabledModules,
      sessionAction: "complete",
      sendWelcome: true,
    });

    return { success: true, orgId, autoLoginToken };
  }

  // Pre-org users have no organizations row (org_id FK is NOT NULL), so the wizard session stays client-side until complete/skip creates the org.
  private ephemeralSession() {
    return {
      id: 0,
      type: "org_setup" as const,
      status: "not_started" as const,
      currentStep: null,
      completedSteps: [],
      skippedSteps: [],
      data: {},
    };
  }

  async getSetupSession(u: CurrentUserContext) {
    const currentTarget = await this.resolveCurrentSetupTarget(u);
    if (currentTarget) {
      return runInTenantTransaction(
        this.db,
        () =>
          this.sessions.getOrCreateSession(
            currentTarget.orgId,
            u.userId,
            "org_setup",
          ),
        { orgId: currentTarget.orgId },
      );
    }

    const memberships = await this.listSetupMemberships(u.userId);
    const target = this.resolveExistingSetupTarget(u, memberships);
    if (!target) return this.ephemeralSession();
    return runInTenantTransaction(
      this.db,
      () =>
        this.sessions.getOrCreateSession(
          target.orgId,
          u.userId,
          "org_setup",
        ),
      { orgId: target.orgId },
    );
  }

  /** Minimal-defaults path for "Set up later" — mirrors the frontend's existing skip defaults. */
  async skipSetup(u: CurrentUserContext, reason?: string) {
    const target = await this.resolveOrCreateOrg(u, {});
    const { orgId } = target;

    if (!target.isOwner) {
      await runInTenantTransaction(
        this.db,
        () => this.sessions.skipSession(orgId, u.userId, "org_setup", reason),
        { orgId },
      );
      return { success: true, orgId };
    }

    const autoLoginToken = randomBytes(32).toString("hex");

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx
          .update(organizations)
          .set({
            industry: "IT Services",
            companySize: "1-10",
            onboardingCompletedAt: new Date(),
          })
          .where(eq(organizations.id, orgId));

        await this.provisionOrgModules(
          tx,
          orgId,
          DEFAULT_SKIP_MODULES,
          u.userId,
        );
        await provisionEmployeeSelfService(tx, orgId);

        await tx
          .update(users)
          .set({ lastActiveOrgId: orgId })
          .where(eq(users.id, u.userId));

        await tx.insert(magicLinkTokens).values({
          id: randomUUID(),
          userId: u.userId,
          tokenHash: createHash("sha256").update(autoLoginToken).digest("hex"),
          expiresAt: addMinutes(new Date(), 10),
        });
      },
      { orgId },
    );

    await this.cache.invalidate(CACHE_KEYS.userSession(u.userId));
    this.schedulePostSetupWork({
      orgId,
      userId: u.userId,
      moduleKeys: DEFAULT_SKIP_MODULES,
      sessionAction: "skip",
      skipReason: reason,
    });

    this.audit.log({
      action: "org.setup.skipped",
      userId: u.userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });

    return { success: true, orgId, autoLoginToken };
  }
}
