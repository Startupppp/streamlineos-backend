import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  roles,
  users,
  orgModules,
  subscriptions,
  organizations,
  magicLinkTokens,
  organizationMembers,
  rolePermissionGrants,
} from "../../db/schema";
import { addDays, addMinutes } from "date-fns";
import { type Db } from "../../db/drizzle.module";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type SetupInput } from "./dto/org.schemas";
import { OnboardingSessionService } from "../onboarding-flow/onboarding-session.service";
import { EmailService } from "../email/email.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { moduleKeysFromOrgModuleValues } from "../../common/rbac/module-vocabulary";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { ModuleChecklistService } from "../onboarding-flow/module-checklist.service";
import {
  getTrialDays,
  TRIAL_PLAN,
} from "../billing/plan-entitlements.constants";

const DEFAULT_SKIP_MODULES = ["HR", "CRM", "PROJECTS"];

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

    const orphanIds = memberships.map((m) => m.id);
    if (orphanIds.length > 0) {
      await this.db
        .delete(organizationMembers)
        .where(inArray(organizationMembers.id, orphanIds));
    }

    const orgId = randomUUID();
    const orgName = input.companyName?.trim() || "My Organization";

    await this.db.transaction(async (tx) => {
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
        role: "owner",
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
      const [adminRole] = await tx
        .insert(roles)
        .values({
          name: "Administrator",
          slug: "ADMIN",
          isSystem: false,
          orgId,
        })
        .returning();

      await tx.insert(rolePermissionGrants).values(
        PERMISSIONS.map((permission) => ({
          orgId,
          roleId: adminRole.id,
          permissionKey: permission.name,
          scope: "all" as const,
        })),
      );

      await bumpPermissionsVersion(tx, orgId);
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

  private async provisionOrgModules(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    orgModuleValues: readonly string[],
    enabledBy: string,
  ): Promise<void> {
    const moduleKeys = moduleKeysFromOrgModuleValues(orgModuleValues);
    if (moduleKeys.length === 0) return;
    await tx
      .insert(orgModules)
      .values(
        moduleKeys.map((moduleKey) => ({
          orgId,
          moduleKey,
          enabled: true,
          enabledBy,
        })),
      )
      .onConflictDoUpdate({
        target: [orgModules.orgId, orgModules.moduleKey],
        set: { enabled: true, enabledBy },
      });
  }

  async completeSetup(u: CurrentUserContext, input: SetupInput) {
    const orgId = await this.resolveOrCreateOrg(u, input);
    if (u.orgId && !u.isOrgOwner) return { success: true, orgId };

    await this.db.transaction(async (tx) => {
      await tx
        .update(organizations)
        .set({
          industry: input.industry,
          companySize: input.companySize,
          ...(input.country ? { country: input.country } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
          ...(input.companyName ? { name: input.companyName } : {}),
          enabledModules: input.enabledModules,
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
    });

    await this.cache.invalidate(CACHE_KEYS.userSession(u.userId));

    await this.checklists.ensureChecklistsForModules(orgId, input.enabledModules);

    await this.sessions.completeSession(orgId, u.userId, "org_setup");
    await this.sendWelcome(u.userId);

    const autoLoginToken = randomBytes(32).toString("hex");
    await this.db.insert(magicLinkTokens).values({
      id: randomUUID(),
      userId: u.userId,
      tokenHash: createHash("sha256").update(autoLoginToken).digest("hex"),
      expiresAt: addMinutes(new Date(), 10),
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

    await this.db.transaction(async (tx) => {
      await tx
        .update(organizations)
        .set({
          industry: "IT Services",
          companySize: "1-10",
          enabledModules: DEFAULT_SKIP_MODULES,
          onboardingCompletedAt: new Date(),
        })
        .where(eq(organizations.id, orgId));

      await this.provisionOrgModules(tx, orgId, DEFAULT_SKIP_MODULES, u.userId);

      await tx
        .update(users)
        .set({ lastActiveOrgId: orgId })
        .where(eq(users.id, u.userId));
    });

    await this.cache.invalidate(CACHE_KEYS.userSession(u.userId));
    await this.checklists.ensureChecklistsForModules(
      orgId,
      DEFAULT_SKIP_MODULES,
    );
    await this.sessions.skipSession(orgId, u.userId, "org_setup", reason);

    this.audit.log({
      action: "org.setup.skipped",
      userId: u.userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });

    const autoLoginToken = randomBytes(32).toString("hex");
    await this.db.insert(magicLinkTokens).values({
      id: randomUUID(),
      userId: u.userId,
      tokenHash: createHash("sha256").update(autoLoginToken).digest("hex"),
      expiresAt: addMinutes(new Date(), 10),
    });

    return { success: true, orgId, autoLoginToken };
  }
}
