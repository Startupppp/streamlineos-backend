import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  inboxRecords,
  invitations,
  organizationSetupInvitationReceipts,
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
import type { TenantTx } from "../../../common/tenant/with-tenant";
import { OrgSetupResolverService } from "./org-setup-resolver.service";
import { ORG_SETUP_COMPLETED_CONSUMER } from "./org-setup-completed-consumer.service";
import {
  resolveProvisioningAndError,
  READY_ENTITLEMENT_STATUSES,
  type OrgSetupStatus,
} from "./org-setup-internals";
import { orgSetupCompletedPayloadSchema } from "./dto/org-setup-completed-payload.schema";
import type { SetupInvitee } from "./dto/org.schemas";
import { recipientOutcomeSchema } from "./dto/org-setup-response.schemas";
import type { z } from "zod";
import { canonicalAdmissionEmail } from "../core/membership-admission.service";

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

  private async resolveInviteeOutcomes(
    tx: TenantTx,
    orgId: string,
    producerEventId: string,
    inviteesFromPayload: readonly SetupInvitee[],
  ): Promise<z.infer<typeof recipientOutcomeSchema>[] | null> {
    const emails = [...new Set(inviteesFromPayload.map((invitee) =>
      canonicalAdmissionEmail(invitee.email),
    ))];
    if (emails.length === 0) return null;

    const receiptRows = await tx
      .select({
        email: organizationSetupInvitationReceipts.canonicalEmail,
        invitationId: organizationSetupInvitationReceipts.invitationId,
        outcome: organizationSetupInvitationReceipts.outcome,
      })
      .from(organizationSetupInvitationReceipts)
      .where(and(
        eq(organizationSetupInvitationReceipts.orgId, orgId),
        eq(organizationSetupInvitationReceipts.producerEventId, producerEventId),
      ));

    const receiptsByEmail = new Map(receiptRows.map((row) => [row.email, row]));
    if (receiptsByEmail.size !== emails.length ||
      emails.some((email) => !receiptsByEmail.has(email))) return null;

    const invitationIds = receiptRows.flatMap((row) =>
      row.invitationId ? [row.invitationId] : [],
    );
    const invitationRows = invitationIds.length > 0
      ? await tx
          .select({ id: invitations.id, status: invitations.status })
          .from(invitations)
          .where(and(
            eq(invitations.orgId, orgId),
            inArray(invitations.id, invitationIds),
          ))
      : [];
    const invitationStatus = new Map(invitationRows.map((row) => [row.id, row.status]));

    return emails.map((email) => {
      const receipt = receiptsByEmail.get(email)!;
      if (receipt.outcome === "SKIPPED_SELF")
        return { email, outcome: "skipped" as const, reason: null };
      if (receipt.outcome === "REFUSED")
        return { email, outcome: "failed" as const, reason: "unknown" as const };

      const status = receipt.invitationId
        ? invitationStatus.get(receipt.invitationId)
        : null;
      if (status === "ACCEPTED")
        return { email, outcome: "successful" as const, reason: null };
      if (status === "DECLINED" || status === "REVOKED")
        return { email, outcome: "failed" as const, reason: "invitation_revoked" as const };
      if (status !== "PENDING")
        return { email, outcome: "failed" as const, reason: "unknown" as const };
      if (receipt.outcome === "DELIVERY_FAILED")
        return { email, outcome: "failed" as const, reason: "email_not_sent" as const };
      return { email, outcome: "queued" as const, reason: null };
    });
  }

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
        recipientOutcomes: null,
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
            recipientOutcomes: null,
          };

        const outboxRows = await tx
          .select({
            eventId: outboxEvents.eventId,
            deliveryState: outboxEvents.deliveryState,
            correlationId: outboxEvents.correlationId,
            payload: outboxEvents.payload,
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
          .limit(1);
        const outboxEventId = outboxRows[0]?.eventId;
        const inboxRows = outboxEventId
          ? await tx
              .select({
                status: inboxRecords.status,
                hasOptionalFailure: sql<boolean>`${inboxRecords.lastError} is not null`,
              })
              .from(inboxRecords)
              .where(
                and(
                  eq(inboxRecords.organizationId, orgId),
                  eq(inboxRecords.consumerName, ORG_SETUP_COMPLETED_CONSUMER),
                  eq(inboxRecords.producerEventId, outboxEventId),
                ),
              )
              .limit(1)
          : [];

        const { provisioning, errorCode } = resolveProvisioningAndError(
          inboxRows[0]?.status ?? null,
          outboxRows[0]?.deliveryState ?? null,
          inboxRows[0]?.hasOptionalFailure ?? false,
        );

        const correlationId =
          errorCode !== null ? (outboxRows[0]?.correlationId ?? null) : null;

        const payloadParseResult = orgSetupCompletedPayloadSchema.safeParse(
          outboxRows[0]?.payload ?? null,
        );

        const recipientOutcomes =
          errorCode === "SETUP_BACKGROUND_PARTIAL" &&
          target.isOwner &&
          outboxEventId !== undefined &&
          payloadParseResult.success &&
          payloadParseResult.data.invitees.length > 0
            ? await this.resolveInviteeOutcomes(
                tx,
                orgId,
                outboxEventId,
                payloadParseResult.data.invitees,
              )
            : null;

        return {
          orgId,
          onboardingCompletedAt,
          ready,
          provisioning,
          errorCode,
          correlationId,
          recipientOutcomes,
        };
      },
      { orgId },
    );
  }
}
