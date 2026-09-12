import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  inboxRecords,
  outboxEvents,
  modulesCatalog,
  orgModules,
  organizationMembers,
  subscriptions,
  organizations,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { OnboardingSessionService } from "../../hr/onboarding/flow/onboarding-session.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { OrgSetupResolverService } from "./org-setup-resolver.service";
import { ORG_SETUP_COMPLETED_CONSUMER } from "./org-setup-completed-consumer.service";
import {
  resolveProvisioningAndError,
  READY_ENTITLEMENT_STATUSES,
  type OrgSetupStatus,
} from "./org-setup-internals";

@Injectable()
export class OrgSetupQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sessions: OnboardingSessionService,
    private readonly resolver: OrgSetupResolverService,
  ) {}

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
   * `ready` and `provisioning` answer two different questions and must stay independent. `ready`
   * is the committed minimum invariant — the caller's own live membership (proved by resolving a
   * target), a stamped organisation, a present ACTIVE owner, an entitlement in
   * `READY_ENTITLEMENT_STATUSES` and an enabled module that still exists in the catalog — all
   * written by bootstrap and the setup transaction, so it is true the instant that transaction
   * commits. It reports those facts; it never grants any of them. `provisioning` tracks only the
   * optional enrichment the outbox consumer performs. The wizard used to wait on `provisioning`,
   * so an offline relay or one failed invitation trapped an owner whose workspace was usable.
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
        ready: false,
        provisioning: "not-started",
        errorCode: null,
        correlationId: null,
      };

    const { orgId } = target;
    return runInTenantTransaction(
      this.db,
      async (tx): Promise<OrgSetupStatus> => {
        const [orgRows, ownerRows, subscriptionRows, enabledModuleRows] =
          await Promise.all([
            tx
              .select({ onboardingCompletedAt: organizations.onboardingCompletedAt })
              .from(organizations)
              .where(eq(organizations.id, orgId))
              .limit(1),
            tx
              .select({ id: organizationMembers.id })
              .from(organizationMembers)
              .where(
                and(
                  eq(organizationMembers.orgId, orgId),
                  eq(organizationMembers.isOwner, true),
                  eq(organizationMembers.status, "ACTIVE"),
                ),
              )
              .limit(1),
            tx
              .select({ status: subscriptions.status })
              .from(subscriptions)
              .where(eq(subscriptions.orgId, orgId))
              .orderBy(desc(subscriptions.createdAt))
              .limit(1),
            tx
              .select({ moduleKey: orgModules.moduleKey })
              .from(orgModules)
              .innerJoin(
                modulesCatalog,
                eq(modulesCatalog.moduleKey, orgModules.moduleKey),
              )
              .where(
                and(
                  eq(orgModules.orgId, orgId),
                  eq(orgModules.enabled, true),
                  eq(modulesCatalog.status, "ACTIVE"),
                ),
              )
              .limit(1),
          ]);

        const onboardingCompletedAt = orgRows[0]?.onboardingCompletedAt ?? null;
        const entitlementStatus = subscriptionRows[0]?.status ?? null;
        const ready =
          onboardingCompletedAt !== null &&
          ownerRows.length > 0 &&
          entitlementStatus !== null &&
          READY_ENTITLEMENT_STATUSES.some(
            (status) => status === entitlementStatus,
          ) &&
          enabledModuleRows.length > 0;

        if (!onboardingCompletedAt)
          return {
            orgId,
            onboardingCompletedAt: null,
            ready: false,
            provisioning: "not-started",
            errorCode: null,
            correlationId: null,
          };

        const [inboxRows, outboxRows] = await Promise.all([
          tx
            .select({
              status: inboxRecords.status,
              hasOptionalFailure: sql<boolean>`${inboxRecords.lastError} is not null`,
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
            .limit(1),
          tx
            .select({
              deliveryState: outboxEvents.deliveryState,
              correlationId: outboxEvents.correlationId,
            })
            .from(outboxEvents)
            .where(
              and(
                eq(outboxEvents.organizationId, orgId),
                eq(outboxEvents.aggregateType, "organization"),
                eq(outboxEvents.aggregateId, orgId),
                eq(outboxEvents.eventType, "organization.setup.completed"),
              ),
            )
            .orderBy(desc(outboxEvents.aggregateVersion))
            .limit(1),
        ]);

        const { provisioning, errorCode } = resolveProvisioningAndError(
          inboxRows[0]?.status ?? null,
          outboxRows[0]?.deliveryState ?? null,
          inboxRows[0]?.hasOptionalFailure ?? false,
        );

        const correlationId =
          errorCode !== null ? (outboxRows[0]?.correlationId ?? null) : null;

        return {
          orgId,
          onboardingCompletedAt,
          ready,
          provisioning,
          errorCode,
          correlationId,
        };
      },
      { orgId },
    );
  }
}
