import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { timesheetPeriods } from "../../../db/schema";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import {
  ApprovalsService,
  isExpectedApprovalSkip,
  membershipUserIds,
  periodOwnerUserIdOrWarn,
} from "./approvals.service";
import { applyBulkRejection, applyRejection } from "./lib/rejection-transition";
import type {
  BulkApproveInput,
  BulkRejectInput,
  RejectPeriodInput,
} from "./dto/approvals.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

/*
  The service decides who and whether: it reads the periods, runs the guard on
  each, resolves the owners, opens the transaction and sends the notices once it
  commits. What a rejection writes inside that transaction is in
  `lib/rejection-transition.ts`, beside `lib/approval-transition.ts`.
*/
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

    const owners = await membershipUserIds(this.db, u.orgId, [period.userMembershipId]);
    const ownerUserId = periodOwnerUserIdOrWarn(owners, period.userMembershipId, {
      orgId: u.orgId,
      periodId,
      operation: "reject",
    });

    const now = new Date();
    await this.db.transaction((tx) =>
      applyRejection(tx, { audit: this.audit }, u, periodId, {
        input,
        ownerUserId,
        now,
      }),
    );

    if (ownerUserId) {
      await this.approvals.notifyPeriodRejected(u, {
        periodId,
        ownerUserId,
        title: `Timesheet rejected: ${period.periodStart} to ${period.periodEnd}`,
        message: `Your timesheet for ${period.periodStart}–${period.periodEnd} was rejected: ${input.reason}`,
        variables: {
          periodId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          reason: input.reason,
        },
      });
    }

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

  async bulkApprove(u: CurrentUserContext, input: BulkApproveInput) {
    let approved = 0;
    let skipped = 0;
    for (const periodId of input.periodIds) {
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
          inArray(timesheetPeriods.id, input.periodIds),
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
    const owners = await membershipUserIds(
      this.db,
      u.orgId,
      periods.map((p) => p.userMembershipId),
    );

    await this.db.transaction((tx) =>
      applyBulkRejection(tx, { audit: this.audit }, u, ids, {
        input,
        owners,
        now,
      }),
    );

    /**
     * One notification per worker, after the batch commits. A bulk rejection is
     * one action for the approver and N separate pieces of bad news for N
     * people, each of whom needs the reason and their own period link.
     */
    for (const p of periods) {
      const ownerUserId =
        p.userMembershipId === null ? undefined : owners.get(p.userMembershipId);
      if (!ownerUserId) continue;
      await this.approvals.notifyPeriodRejected(u, {
        periodId: p.id,
        ownerUserId,
        title: "Timesheet rejected",
        message: `Your submitted timesheet was rejected: ${input.reason}`,
        variables: { periodId: p.id, reason: input.reason },
      });
    }

    return { rejected: ids.length };
  }
}
