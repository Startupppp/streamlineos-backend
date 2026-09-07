import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { timesheetPeriods, timesheets, timesheetSettings } from "../../../db/schema";
import { actingMembershipId } from "../../../common/auth/principal";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import { bulkUpdateFromValues } from "../../../common/db/bulk-update";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { ApprovalsService } from "./approvals.service";
import { RateResolverService } from "./rate-resolver.service";
import { canActOnPeriod } from "./lib/approval-guard";
import type {
  BulkApproveInput,
  BulkRejectInput,
  RejectPeriodInput,
} from "./dto/approvals.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

@Injectable()
export class ApprovalsBulkService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: TimesheetsAuditService,
    private readonly approvals: ApprovalsService,
    private readonly rateResolver: RateResolverService,
  ) {}

  async rejectPeriod(
    u: CurrentUserContext,
    periodId: number,
    input: RejectPeriodInput,
  ) {
    const [period] = await this.db
      .select()
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.id, periodId),
          eq(timesheetPeriods.orgId, u.orgId),
        ),
      )
      .limit(1);

    if (!period) throw new NotFoundException("Period not found");
    if (period.status !== "SUBMITTED")
      throw new ConflictException("Only submitted periods can be rejected");
    await this.approvals.assertCanActOnPeriod(u, period);

    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheetPeriods)
        .set({
          status: "REJECTED",
          rejectedAt: now,
          rejectionReason: input.reason,
          updatedAt: now,
        })
        .where(
          and(
            eq(timesheetPeriods.id, periodId),
            eq(timesheetPeriods.orgId, u.orgId),
          ),
        );

      await tx
        .update(timesheets)
        .set({
          status: "REJECTED",
          rejectionReason: input.reason,
          updatedAt: now,
        })
        .where(
          and(
            eq(timesheets.timesheetPeriodId, periodId),
            eq(timesheets.orgId, u.orgId),
            isNull(timesheets.voidedAt),
          ),
        );

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorMembershipId: actingMembershipId(u.principal),
        entityType: "period",
        entityId: periodId.toString(),
        action: "period.rejected",
        reason: input.reason,
      });
    });

    const [updated] = await this.db
      .select()
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.id, periodId),
          eq(timesheetPeriods.orgId, u.orgId),
        ),
      )
      .limit(1);

    return updated;
  }

  /**
   * A mixed-tenant id list must fail the whole request. Both bulk actions used
   * to fold a foreign id into their ordinary skip path — `isExpectedApprovalSkip`
   * swallows the `NotFoundException`, and the reject query narrows to the
   * caller's org in the same predicate as the status filter — so the caller was
   * told the request succeeded. Tenant membership is checked first and on its
   * own, which leaves the per-period status and approver skips meaning what they
   * say. A miss is 404, never 403.
   */
  private async assertPeriodsInOrg(orgId: string, periodIds: readonly number[]): Promise<number[]> {
    const requestedIds = [...new Set(periodIds)];
    const owned = await this.db
      .select({ id: timesheetPeriods.id })
      .from(timesheetPeriods)
      .where(
        and(eq(timesheetPeriods.orgId, orgId), inArray(timesheetPeriods.id, requestedIds)),
      )
      .limit(requestedIds.length);
    if (owned.length !== requestedIds.length)
      throw new NotFoundException("One or more period IDs not found in this organization");
    return requestedIds;
  }

  async bulkApprove(u: CurrentUserContext, input: BulkApproveInput) {
    const requestedIds = await this.assertPeriodsInOrg(u.orgId, input.periodIds);

    const candidates = await this.db
      .select({
        id: timesheetPeriods.id,
        userMembershipId: timesheetPeriods.userMembershipId,
        currentApproverMembershipId: timesheetPeriods.currentApproverMembershipId,
      })
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.orgId, u.orgId),
          inArray(timesheetPeriods.id, requestedIds),
          eq(timesheetPeriods.status, "SUBMITTED"),
        ),
      );

    const actorMembershipIdForDelegation = actingMembershipId(u.principal);
    const delegations =
      actorMembershipIdForDelegation === null
        ? new Set<number>()
        : await this.approvals.activeDelegationsToActor(
            u.orgId,
            actorMembershipIdForDelegation,
            candidates
              .map(p => p.currentApproverMembershipId)
              .filter((id): id is number => id !== null),
          );

    const membershipId = actingMembershipId(u.principal);
    const actor = { membershipId, isOrgOwner: !!u.isOrgOwner };

    const approvable: typeof candidates = [];
    for (const p of candidates) {
      const delegateeOfApprover =
        p.currentApproverMembershipId !== null &&
        membershipId !== null &&
        p.currentApproverMembershipId !== membershipId &&
        p.userMembershipId !== membershipId
          ? delegations.has(p.currentApproverMembershipId)
          : false;
      const decision = canActOnPeriod(actor, p, { delegateeOfApprover });
      if (decision.allowed) approvable.push(p);
    }

    const skipped = requestedIds.length - approvable.length;
    if (approvable.length === 0) return { approved: 0, skipped };

    const ids = approvable.map(p => p.id);

    const approverActor = await assertOrganizationActor(this.db, u.orgId, {
      kind: "user",
      userId: u.userId,
    }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    });

    const [settings] = await this.db
      .select({ lockAfterApproval: timesheetSettings.lockAfterApproval })
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, u.orgId))
      .limit(1);
    const lockAfterApproval = settings?.lockAfterApproval ?? true;

    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheetPeriods)
        .set({
          status: "APPROVED",
          approvedAt: now,
          approvedByMembershipId: approverActor.membershipId,
          lockedAt: lockAfterApproval ? now : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(timesheetPeriods.orgId, u.orgId),
            inArray(timesheetPeriods.id, ids),
          ),
        );

      await tx
        .update(timesheets)
        .set({
          status: "APPROVED",
          approvedByMembershipId: approverActor.membershipId,
          approvedAt: now,
          lockedAt: lockAfterApproval ? now : null,
          lockedByMembershipId: lockAfterApproval ? approverActor.membershipId : null,
          updatedAt: now,
        })
        .where(
          and(
            inArray(timesheets.timesheetPeriodId, ids),
            eq(timesheets.orgId, u.orgId),
            isNull(timesheets.voidedAt),
          ),
        );

      const billableEntries = await tx
        .select()
        .from(timesheets)
        .where(
          and(
            inArray(timesheets.timesheetPeriodId, ids),
            eq(timesheets.orgId, u.orgId),
            eq(timesheets.isBillable, true),
            isNull(timesheets.billRate),
            isNull(timesheets.voidedAt),
          ),
        );

      const resolvedRates = await this.rateResolver.resolveMany(
        u.orgId,
        billableEntries.map(entry => ({
          projectId: entry.projectId,
          userMembershipId: entry.userMembershipId,
          ticketId: entry.ticketId,
          date: entry.date,
        })),
      );

      const rateRows: Array<{ key: number; values: [string, string | null, string, string | null] }> = [];
      for (const [i, entry] of billableEntries.entries()) {
        const resolved = resolvedRates[i];
        if (!resolved || resolved.billRate === null) continue;
        rateRows.push({
          key: entry.id,
          values: [
            resolved.billRate.toString(),
            resolved.costRate !== null ? resolved.costRate.toString() : null,
            resolved.currency,
            resolved.source,
          ],
        });
      }
      if (rateRows.length > 0) {
        await bulkUpdateFromValues(tx, {
          table: timesheets,
          orgId: u.orgId,
          key: { column: "id", type: "integer" },
          columns: [
            { column: "bill_rate", type: "numeric(10, 2)" },
            { column: "cost_rate", type: "numeric(10, 2)" },
            { column: "currency", type: "text" },
            { column: "rate_source", type: "timesheet_rate_source" },
          ],
          rows: rateRows,
          touch: ["updated_at"],
        });
      }

      await this.audit.recordMany(
        tx,
        ids.map(id => ({
          orgId: u.orgId,
          actorMembershipId: actingMembershipId(u.principal),
          entityType: "period",
          entityId: id.toString(),
          action: "period.approved",
          after: { status: "APPROVED" },
        })),
      );
    });

    return { approved: ids.length, skipped };
  }

  async bulkReject(u: CurrentUserContext, input: BulkRejectInput) {
    const requestedIds = await this.assertPeriodsInOrg(u.orgId, input.periodIds);
    const candidates = await this.db
      .select({
        id: timesheetPeriods.id,
        status: timesheetPeriods.status,
        userMembershipId: timesheetPeriods.userMembershipId,
        currentApproverMembershipId: timesheetPeriods.currentApproverMembershipId,
      })
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.orgId, u.orgId),
          inArray(timesheetPeriods.id, requestedIds),
          eq(timesheetPeriods.status, "SUBMITTED"),
        ),
      );

    const actorMembershipIdForDelegation = actingMembershipId(u.principal);
    const delegations =
      actorMembershipIdForDelegation === null
        ? new Set<number>()
        : await this.approvals.activeDelegationsToActor(
            u.orgId,
            actorMembershipIdForDelegation,
            candidates
              .map((p) => p.currentApproverMembershipId)
              .filter((id): id is number => id !== null),
          );

    const periods = [];
    for (const p of candidates) {
      try {
        await this.approvals.assertCanActOnPeriod(u, p, delegations);
        periods.push(p);
      } catch (err) {
        if (!(err instanceof ForbiddenException)) {
          logger.warn("bulkReject: assertCanActOnPeriod failed unexpectedly", {
            orgId: u.orgId,
            periodId: p.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (periods.length === 0) return { rejected: 0 };

    const now = new Date();
    const ids = periods.map((p) => p.id);

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheetPeriods)
        .set({
          status: "REJECTED",
          rejectedAt: now,
          rejectionReason: input.reason,
          updatedAt: now,
        })
        .where(
          and(
            eq(timesheetPeriods.orgId, u.orgId),
            inArray(timesheetPeriods.id, ids),
          ),
        );

      await tx
        .update(timesheets)
        .set({
          status: "REJECTED",
          rejectionReason: input.reason,
          updatedAt: now,
        })
        .where(
          and(
            inArray(timesheets.timesheetPeriodId, ids),
            eq(timesheets.orgId, u.orgId),
            isNull(timesheets.voidedAt),
          ),
        );

      const actorMembId = actingMembershipId(u.principal);
      await this.audit.recordMany(
        tx,
        ids.map((id) => ({
          orgId: u.orgId,
          actorMembershipId: actorMembId,
          entityType: "period",
          entityId: id.toString(),
          action: "period.rejected",
          reason: input.reason,
        })),
      );
    });

    return { rejected: ids.length };
  }
}
