import { Inject, Injectable } from "@nestjs/common";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  users,
  orgModules,
  modulesCatalog,
  moduleOwnerships,
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
import { EmailService } from "../../email/email.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { logger } from "../../../common/logger/logger.service";
import { ACCESS_MANAGED_MODULES } from "../../rbac/permissions";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { bumpPermissionsVersion } from "../../../common/rbac/access-invalidate";
import {
  runInNewTenantTransaction,
  runInTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import { seedSystemRolesForOrg } from "../../rbac/seed-system-roles";
import { ModuleChecklistService } from "../../hr/onboarding/flow/module-checklist.service";
import {
  getTrialDays,
  TRIAL_PLAN,
} from "../../billing/core/plan-entitlements.constants";

const DEFAULT_SKIP_MODULES = ["hr", "crm", "build"];
const OWNERSHIP_MANAGED_MODULES = new Set<string>(ACCESS_MANAGED_MODULES);

@Injectable()
export class OrgSetupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly sessions: OnboardingSessionService,
    private readonly checklists: ModuleChecklistService,
    private readonly email: EmailService,
  ) {}

  private async sendWelcome(userId: string): Promise<void> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { email: true, name: true, firstName: true },
    });
    if (!user?.email) return;
    const name = user.name?.trim() || user.firstName?.trim() || user.email;
    const base = (process.env.EMAIL_APP_URL ?? process.env.APP_URL ?? "")
      .trim()
      .replace(/\/$/, "");
    void this.email
      .sendWelcomeEmail(user.email, name, `${base}/dashboard`)
      .catch((error: unknown) => {
        logger.error("Welcome email send failed", { userId, error });
      });
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

  private async resolveOrCreateOrg(
    u: CurrentUserContext,
    input: Pick<SetupInput, "companyName">,
  ): Promise<string> {
    if (u.orgId) {
      const existingOrg = await this.db.query.organizations.findFirst({
        where: eq(organizations.id, u.orgId),
        columns: { id: true },
      });
      if (existingOrg) {
        return u.orgId;
      }
    }

    const memberships = await this.db
      .select({
        id: organizationMembers.id,
        orgId: organizationMembers.orgId,
        existingOrgId: organizations.id,
      })
      .from(organizationMembers)
      .leftJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(eq(organizationMembers.userId, u.userId))
      .orderBy(desc(organizationMembers.joinedAt));

    const valid = memberships.find((m) => m.existingOrgId !== null);
    if (valid) {
      return valid.orgId;
    }

    const orphansByOrg = new Map<string, number[]>();
    for (const m of memberships) {
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
      await bumpPermissionsVersion(tx, orgId);
      await seedSystemRolesForOrg(this.db, orgId);
    });

    this.audit.log({
      action: "org.created",
      userId: u.userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });
    return orgId;
  }

  /**
   * Records the org's module choice for EVERY catalog module — the selected
   * ones enabled, the rest explicitly disabled — so the org runs exactly what
   * the owner picked in the wizard. Writing the `false` rows (rather than
   * leaving them absent) keeps `org_modules` a complete, auditable record and
   * keeps the module list, the access snapshot, and `ModuleGuard` in agreement.
   * Core modules stay on regardless of selection.
   */
  private async provisionOrgModules(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    moduleKeys: readonly string[],
    enabledBy: string,
  ): Promise<void> {
    const selected = new Set(moduleKeys);
    const catalog = await tx
      .select({ moduleKey: modulesCatalog.moduleKey, isCore: modulesCatalog.isCore })
      .from(modulesCatalog);

    const rows =
      catalog.length > 0
        ? catalog.map((entry) => ({
            orgId,
            moduleKey: entry.moduleKey,
            enabled: entry.isCore === true || selected.has(entry.moduleKey),
            enabledBy,
          }))
        : moduleKeys.map((moduleKey) => ({ orgId, moduleKey, enabled: true, enabledBy }));

    if (rows.length === 0) return;

    await tx
      .insert(orgModules)
      .values(rows)
      .onConflictDoUpdate({
        target: [orgModules.orgId, orgModules.moduleKey],
        set: { enabled: sql`excluded.enabled`, enabledBy: sql`excluded.enabled_by` },
      });

    const eligibleKeys = moduleKeys.filter((key) => OWNERSHIP_MANAGED_MODULES.has(key));
    if (eligibleKeys.length === 0) return;

    const [orgRow] = await tx
      .select({ ownerMembershipId: organizations.ownerMembershipId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    const ownerMembershipId = orgRow?.ownerMembershipId;
    if (ownerMembershipId === null || ownerMembershipId === undefined) return;

    await tx
      .insert(moduleOwnerships)
      .values(
        eligibleKeys.map((moduleKey) => ({
          orgId,
          moduleKey,
          ownerMembershipId,
        })),
      )
      .onConflictDoNothing();
  }

  async completeSetup(u: CurrentUserContext, input: SetupInput) {
    const orgId = await this.resolveOrCreateOrg(u, input);
    if (u.orgId && !u.isOrgOwner) return { success: true, orgId };

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

        await this.provisionOrgModules(tx, orgId, input.enabledModules, u.userId);

        await tx
          .update(users)
          .set({
            lastActiveOrgId: orgId,
            ...(input.phone ? { phone: input.phone } : {}),
          })
          .where(eq(users.id, u.userId));

        await this.checklists.ensureChecklistsForModules(orgId, input.enabledModules);
        await this.sessions.completeSession(orgId, u.userId, "org_setup");

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
    await this.sendWelcome(u.userId);

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
    if (!u.orgId) return this.ephemeralSession();
    return this.sessions.getOrCreateSession(u.orgId, u.userId, "org_setup");
  }

  /** Minimal-defaults path for "Set up later" — mirrors the frontend's existing skip defaults. */
  async skipSetup(u: CurrentUserContext, reason?: string) {
    const orgId = await this.resolveOrCreateOrg(u, {});

    if (u.orgId && !u.isOrgOwner) {
      await this.sessions.skipSession(orgId, u.userId, "org_setup", reason);
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

        await this.provisionOrgModules(tx, orgId, DEFAULT_SKIP_MODULES, u.userId);

        await tx
          .update(users)
          .set({ lastActiveOrgId: orgId })
          .where(eq(users.id, u.userId));

        await this.checklists.ensureChecklistsForModules(orgId, DEFAULT_SKIP_MODULES);
        await this.sessions.skipSession(orgId, u.userId, "org_setup", reason);

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
