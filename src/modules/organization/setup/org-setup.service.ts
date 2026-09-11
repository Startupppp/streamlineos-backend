import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  inboxRecords,
  outboxEvents,
  users,
  organizations,
  magicLinkTokens,
} from "../../../db/schema";
import { addMinutes } from "date-fns";
import { type Db } from "../../../db/drizzle.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type SetupInput, type SetupInvitee } from "./dto/org.schemas";
import { OnboardingSessionService } from "../../hr/onboarding/flow/onboarding-session.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  runInTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import type { TenantTx } from "../../../common/tenant/with-tenant";
import {
  DEFAULT_SKIP_MODULES,
  provisionOrgModules,
} from "../../../common/org/provision-org-modules";
import { provisionEmployeeSelfService } from "../../../common/org/provision-employee-self-service";
import { OrgSetupResolverService } from "./org-setup-resolver.service";
import { AccountOrganizationIndexService } from "../core/account-organization-index.service";
import { ORG_SETUP_COMPLETED_CONSUMER } from "./org-setup-completed-consumer.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";

export { DEFAULT_SKIP_MODULES, provisionOrgModules };

export type OrgSetupProvisioningState =
  | "not-started"
  | "pending"
  | "in-progress"
  | "completed"
  | "failed";

export interface OrgSetupStatus {
  orgId: string | null;
  onboardingCompletedAt: Date | null;
  provisioning: OrgSetupProvisioningState;
  lastError: string | null;
}

const SKIP_INDUSTRY = "IT Services";
const SKIP_COMPANY_SIZE = "1-10";

@Injectable()
export class OrgSetupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly sessions: OnboardingSessionService,
    private readonly resolver: OrgSetupResolverService,
    private readonly accountOrgIndex: AccountOrganizationIndexService,
  ) {}

  /**
   * The setup work that must outlive the request: RBAC role seeding, module checklists, the
   * industry workspace structure, the wizard's invitations, closing the setup session and the
   * welcome notification.
   *
   * It used to run in a bare `setImmediate` whose only failure handler was a log line, so a crash
   * or a single throwing step left a new organisation half-provisioned with nothing to retry it.
   * The structure generation and the invitations were worse still: the BROWSER sequenced them
   * after the response, so closing the tab dropped them. Emitting inside the caller's transaction
   * makes the intent commit atomically with `onboarding_completed_at`;
   * `OrgSetupCompletedConsumerService` performs it, and the outbox relay retries until it succeeds
   * or dead-letters visibly.
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
      industry: string | null;
      invitees: readonly SetupInvitee[];
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
        industry: input.industry,
        invitees: input.invitees.map((invitee) => ({ ...invitee })),
      },
      occurredAt: now,
    });
  }

  // Runs on replays too, and writes before invalidating so no concurrent read re-caches the old org.
  private async publishSetupResult(userId: string, orgId: string): Promise<void> {
    await this.accountOrgIndex.activate(userId, orgId);
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
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

  /**
   * The wizard's natural idempotency (no `@Idempotent`, which would 400 every caller that sends
   * no `Idempotency-Key`).
   *
   * The stamp is claimed by a conditional UPDATE rather than a read-then-write, so two concurrent
   * replays cannot both see a null and both proceed. A replay that loses the race writes nothing:
   * no second `organization.setup.completed` with `sendWelcome: true`, and no second
   * `magic_link_tokens` row — that row is a login credential, and minting a fresh one per retry
   * hands out a new one on every double-submit.
   */
  private async claimOnboardingStamp(
    tx: TenantTx,
    orgId: string,
    now: Date,
    profile: Partial<typeof organizations.$inferInsert>,
  ): Promise<boolean> {
    const claimed = await tx
      .update(organizations)
      .set({ ...profile, onboardingCompletedAt: now })
      .where(
        and(
          eq(organizations.id, orgId),
          isNull(organizations.onboardingCompletedAt),
        ),
      )
      .returning({ id: organizations.id });
    return claimed.length > 0;
  }

  async completeSetup(u: CurrentUserContext, input: SetupInput) {
    const target = await this.resolver.resolveOrCreateOrg(u, input);
    const { orgId } = target;
    if (!target.isOwner) {
      await this.publishSetupResult(u.userId, orgId);
      return { success: true, orgId };
    }

    const autoLoginToken = randomBytes(32).toString("hex");
    const now = new Date();

    const claimed = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const stamped = await this.claimOnboardingStamp(tx, orgId, now, {
          industry: input.industry,
          companySize: input.companySize,
          ...(input.country ? { country: input.country } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
          ...(input.companyName ? { name: input.companyName } : {}),
        });
        if (!stamped) return false;

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
          industry: input.industry,
          invitees: input.invitees ?? [],
        });
        return true;
      },
      { orgId },
    );

    await this.publishSetupResult(u.userId, orgId);

    if (!claimed) return { success: true, orgId };

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

  /**
   * What the wizard polls instead of sequencing provisioning from the browser.
   *
   * `onboarding_completed_at` answers "is the wizard finished"; the setup-completed consumer's
   * inbox row answers "has the asynchronous half landed". A stamped organisation with no inbox row
   * is `pending` — the relay has not claimed the event yet — which is deliberately distinct from
   * `not-started`, so a client cannot read "nothing has happened" from work that is merely queued.
   */
  async getSetupStatus(u: CurrentUserContext): Promise<OrgSetupStatus> {
    const target =
      (await this.resolver.resolveCurrentSetupTarget(u)) ??
      this.resolver.resolveExistingSetupTarget(
        u,
        await this.resolver.listSetupMemberships(u.userId),
      );

    if (!target)
      return {
        orgId: null,
        onboardingCompletedAt: null,
        provisioning: "not-started",
        lastError: null,
      };

    const { orgId } = target;
    return runInTenantTransaction(
      this.db,
      async (tx): Promise<OrgSetupStatus> => {
        const [org] = await tx
          .select({ onboardingCompletedAt: organizations.onboardingCompletedAt })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1);

        const onboardingCompletedAt = org?.onboardingCompletedAt ?? null;
        if (!onboardingCompletedAt)
          return {
            orgId,
            onboardingCompletedAt: null,
            provisioning: "not-started",
            lastError: null,
          };

        const [record] = await tx
          .select({
            status: inboxRecords.status,
            lastError: inboxRecords.lastError,
          })
          .from(inboxRecords)
          .where(
            and(
              eq(inboxRecords.organizationId, orgId),
              eq(inboxRecords.consumerName, ORG_SETUP_COMPLETED_CONSUMER),
              eq(inboxRecords.aggregateType, "organization"),
              eq(inboxRecords.aggregateId, orgId),
            ),
          )
          .orderBy(desc(inboxRecords.aggregateVersion))
          .limit(1);

        const [event] = await tx
          .select({
            deliveryState: outboxEvents.deliveryState,
            lastError: outboxEvents.lastError,
          })
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.organizationId, orgId),
              eq(outboxEvents.eventType, "organization.setup.completed"),
            ),
          )
          .orderBy(desc(outboxEvents.occurredAt))
          .limit(1);

        const provisioning = resolveProvisioningState(record?.status ?? null);
        if (provisioning === "pending" && event?.deliveryState === "DEAD")
          return { orgId, onboardingCompletedAt, provisioning: "failed", lastError: event.lastError };

        return {
          orgId,
          onboardingCompletedAt,
          provisioning,
          lastError: record?.lastError ?? event?.lastError ?? null,
        };
      },
      { orgId },
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
      await this.publishSetupResult(u.userId, orgId);
      return { success: true, orgId };
    }

    const autoLoginToken = randomBytes(32).toString("hex");
    const now = new Date();

    const claimed = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const stamped = await this.claimOnboardingStamp(tx, orgId, now, {
          industry: SKIP_INDUSTRY,
          companySize: SKIP_COMPANY_SIZE,
        });
        if (!stamped) return false;

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
          industry: SKIP_INDUSTRY,
          invitees: [],
        });
        return true;
      },
      { orgId },
    );

    await this.publishSetupResult(u.userId, orgId);

    if (!claimed) return { success: true, orgId };

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

function resolveProvisioningState(
  inboxStatus: string | null,
): OrgSetupProvisioningState {
  if (inboxStatus === null) return "pending";
  if (inboxStatus === "COMPLETED" || inboxStatus === "SKIPPED") return "completed";
  if (inboxStatus === "FAILED") return "failed";
  return "in-progress";
}
