import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  accountOrganizationIndex,
  users,
  organizations,
  magicLinkTokens,
} from "../../../db/schema";
import { addMinutes } from "date-fns";
import { type Db } from "../../../db/drizzle.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type SetupInput } from "./dto/org.schemas";
import { OnboardingSessionService } from "../../hr/onboarding/flow/onboarding-session.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { logger } from "../../../common/logger/logger.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
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
import { OrgSetupResolverService } from "./org-setup-resolver.service";

export { DEFAULT_SKIP_MODULES, provisionOrgModules };

@Injectable()
export class OrgSetupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly sessions: OnboardingSessionService,
    private readonly checklists: ModuleChecklistService,
    private readonly dispatch: NotificationDispatchService,
    private readonly resolver: OrgSetupResolverService,
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

  private provisionOrgModules(
    tx: TenantTx,
    orgId: string,
    moduleKeys: readonly string[],
    enabledBy: string,
  ): Promise<void> {
    return provisionOrgModules(tx, orgId, moduleKeys, enabledBy);
  }

  async completeSetup(u: CurrentUserContext, input: SetupInput) {
    const target = await this.resolver.resolveOrCreateOrg(u, input);
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
    void withIdentity(this.db, u.userId, (tx) =>
      tx
        .update(accountOrganizationIndex)
        .set({ lastActivatedAt: new Date() })
        .where(
          and(
            eq(accountOrganizationIndex.userId, u.userId),
            eq(accountOrganizationIndex.orgId, orgId),
          ),
        ),
    ).catch((error: unknown) => {
      logger.error('[account-org-index] last-activated write failed', {
        userId: u.userId,
        orgId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.schedulePostSetupWork({
      orgId,
      userId: u.userId,
      moduleKeys: input.enabledModules,
      sessionAction: "complete",
      sendWelcome: true,
    });

    return { success: true, orgId, autoLoginToken };
  }

  async getSetupSession(u: CurrentUserContext) {
    const currentTarget = await this.resolver.resolveCurrentSetupTarget(u);
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

    const memberships = await this.resolver.listSetupMemberships(u.userId);
    const target = this.resolver.resolveExistingSetupTarget(u, memberships);
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

  async skipSetup(u: CurrentUserContext, reason?: string) {
    const target = await this.resolver.resolveOrCreateOrg(u, {});
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
    void withIdentity(this.db, u.userId, (tx) =>
      tx
        .update(accountOrganizationIndex)
        .set({ lastActivatedAt: new Date() })
        .where(
          and(
            eq(accountOrganizationIndex.userId, u.userId),
            eq(accountOrganizationIndex.orgId, orgId),
          ),
        ),
    ).catch((error: unknown) => {
      logger.error('[account-org-index] last-activated write failed', {
        userId: u.userId,
        orgId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
