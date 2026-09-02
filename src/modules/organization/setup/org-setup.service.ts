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
import {
  DEFAULT_SKIP_MODULES,
  provisionOrgModules,
} from "../../../common/org/provision-org-modules";
import { provisionEmployeeSelfService } from "../../../common/org/provision-employee-self-service";
import { OrgSetupResolverService } from "./org-setup-resolver.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";

export { DEFAULT_SKIP_MODULES, provisionOrgModules };

@Injectable()
export class OrgSetupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly sessions: OnboardingSessionService,
    private readonly resolver: OrgSetupResolverService,
  ) {}

  /**
   * The setup work that must outlive the request: RBAC role seeding, module checklists, closing
   * the setup session and the welcome notification.
   *
   * It used to run in a bare `setImmediate` whose only failure handler was a log line, so a crash
   * or a single throwing step left a new organisation half-provisioned with nothing to retry it.
   * Emitting inside the caller's transaction makes the intent commit atomically with
   * `onboarding_completed_at`; `OrgSetupCompletedConsumerService` performs it, and the outbox
   * relay retries until it succeeds or dead-letters visibly.
   */
  private emitSetupCompleted(
    tx: TenantTx,
    now: Date,
    input: {
      orgId: string;
      userId: string;
      moduleKeys: readonly string[];
      sessionAction: "complete" | "skip";
      skipReason?: string;
      sendWelcome: boolean;
    },
  ): Promise<void> {
    return OutboxWriter.emit(tx, {
      eventId: randomUUID(),
      organizationId: input.orgId,
      aggregateType: "organization",
      aggregateId: input.orgId,
      aggregateVersion: now.getTime(),
      eventType: "organization.setup.completed",
      payload: {
        orgId: input.orgId,
        userId: input.userId,
        moduleKeys: [...input.moduleKeys],
        sessionAction: input.sessionAction,
        skipReason: input.skipReason ?? null,
        sendWelcome: input.sendWelcome,
      },
      occurredAt: now,
    });
  }

  /**
   * `last_activated_at` is a display timestamp that the next organisation switch rewrites, so a
   * failure here is genuinely recoverable and must not fail setup. Awaiting it rather than
   * discarding the promise keeps the failure inside the request that caused it.
   */
  private async touchAccountOrgIndex(userId: string, orgId: string): Promise<void> {
    try {
      await withIdentity(this.db, userId, (tx) =>
        tx
          .update(accountOrganizationIndex)
          .set({ lastActivatedAt: new Date() })
          .where(
            and(
              eq(accountOrganizationIndex.userId, userId),
              eq(accountOrganizationIndex.orgId, orgId),
            ),
          ),
      );
    } catch (error: unknown) {
      logger.error("[account-org-index] last-activated write failed", {
        userId,
        orgId,
        error: error instanceof Error ? error.message : String(error),
      });
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
    const now = new Date();

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
            onboardingCompletedAt: now,
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
          expiresAt: addMinutes(now, 10),
        });

        await this.emitSetupCompleted(tx, now, {
          orgId,
          userId: u.userId,
          moduleKeys: input.enabledModules,
          sessionAction: "complete",
          sendWelcome: true,
        });
      },
      { orgId },
    );

    await this.cache.invalidate(CACHE_KEYS.userSession(u.userId));
    await this.touchAccountOrgIndex(u.userId, orgId);

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
    const now = new Date();

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx
          .update(organizations)
          .set({
            industry: "IT Services",
            companySize: "1-10",
            onboardingCompletedAt: now,
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
          expiresAt: addMinutes(now, 10),
        });

        await this.emitSetupCompleted(tx, now, {
          orgId,
          userId: u.userId,
          moduleKeys: DEFAULT_SKIP_MODULES,
          sessionAction: "skip",
          skipReason: reason,
          sendWelcome: false,
        });
      },
      { orgId },
    );

    await this.cache.invalidate(CACHE_KEYS.userSession(u.userId));
    await this.touchAccountOrgIndex(u.userId, orgId);

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
