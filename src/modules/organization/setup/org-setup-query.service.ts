import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  inboxRecords,
  invitations,
  outboxEvents,
  modulesCatalog,
  orgModules,
  organizationMembers,
  subscriptions,
  organizations,
  users,
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

function inviteeStatusPriority(status: string): number {
  if (status === "ACCEPTED") return 4;
  if (status === "PENDING") return 3;
  if (status === "DECLINED") return 2;
  if (status === "REVOKED") return 1;
  return 0;
}

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
    actorUserId: string,
    inviteesFromPayload: readonly SetupInvitee[],
  ): Promise<z.infer<typeof recipientOutcomeSchema>[]> {
    const [actorUserRow] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, actorUserId))
      .limit(1);

    const actorEmail = actorUserRow
      ? canonicalAdmissionEmail(actorUserRow.email)
      : null;

    const nonSkippedEmails: string[] = [];
    const seenForDedup = new Set<string>();

    for (const invitee of inviteesFromPayload) {
      const email = canonicalAdmissionEmail(invitee.email);
      if (seenForDedup.has(email)) continue;
      seenForDedup.add(email);
      if (email !== actorEmail) nonSkippedEmails.push(email);
    }

    const invitationStatusByEmail = new Map<string, string>();
    if (nonSkippedEmails.length > 0) {
      const invitationRows = await tx
        .select({ email: invitations.email, status: invitations.status })
        .from(invitations)
        .where(
          and(
            eq(invitations.orgId, orgId),
            inArray(invitations.email, nonSkippedEmails),
          ),
        );

      for (const row of invitationRows) {
        const existing = invitationStatusByEmail.get(row.email);
        if (
          !existing ||
          inviteeStatusPriority(row.status) > inviteeStatusPriority(existing)
        ) {
          invitationStatusByEmail.set(row.email, row.status);
        }
      }
    }

    const failedEmails = nonSkippedEmails.filter((email) => {
      const status = invitationStatusByEmail.get(email);
      return status !== "PENDING" && status !== "ACCEPTED";
    });

    const activeMemberEmailSet = new Set<string>();
    if (failedEmails.length > 0) {
      const memberRows = await tx
        .select({ email: users.email })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.status, "ACTIVE"),
            inArray(users.email, failedEmails),
          ),
        );
      for (const row of memberRows) {
        activeMemberEmailSet.add(canonicalAdmissionEmail(row.email));
      }
    }

    const outcomes: z.infer<typeof recipientOutcomeSchema>[] = [];
    const processedEmails = new Set<string>();

    for (const invitee of inviteesFromPayload) {
      const email = canonicalAdmissionEmail(invitee.email);
      if (processedEmails.has(email)) continue;
      processedEmails.add(email);

      if (email === actorEmail) {
        outcomes.push({ email, outcome: "skipped", reason: null });
        continue;
      }

      const status = invitationStatusByEmail.get(email);
      if (status === "PENDING") {
        outcomes.push({ email, outcome: "queued", reason: null });
      } else if (status === "ACCEPTED") {
        outcomes.push({ email, outcome: "successful", reason: null });
      } else if (status === "DECLINED" || status === "REVOKED") {
        outcomes.push({ email, outcome: "failed", reason: "invitation_revoked" });
      } else if (activeMemberEmailSet.has(email)) {
        outcomes.push({ email, outcome: "failed", reason: "already_member" });
      } else {
        outcomes.push({ email, outcome: "failed", reason: "unknown" });
      }
    }

    return outcomes;
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
            .limit(1),
        ]);

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
          u.isOrgOwner &&
          payloadParseResult.success &&
          payloadParseResult.data.invitees.length > 0
            ? await this.resolveInviteeOutcomes(
                tx,
                orgId,
                payloadParseResult.data.userId,
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
