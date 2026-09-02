import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { timesheetPeriods, timesheets } from "../../../db/schema";
import { actingMembershipId } from "../../../common/auth/principal";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { ApprovalsService, isExpectedApprovalSkip } from "./approvals.service";
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
    let approved = 0;
    let skipped = 0;
    for (const periodId of requestedIds) {
      try {
        await this.approvals.approveSinglePeriod(u, periodId);
        approved++;
      } catch (error) {
        if (isExpectedApprovalSkip(error)) {
          skipped++;
          continue;
        }
        logger.error("bulkApprove: failed to approve period", {
          orgId: u.orgId,
          periodId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    return { approved, skipped };
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

    const periods = [];
    for (const p of candidates) {
      try {
        await this.approvals.assertCanActOnPeriod(u, p);
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
      for (const id of ids) {
        await this.audit.record(tx, {
          orgId: u.orgId,
          actorMembershipId: actorMembId,
          entityType: "period",
          entityId: id.toString(),
          action: "period.rejected",
          reason: input.reason,
        });
      }
    });

    return { rejected: ids.length };
  }
}
