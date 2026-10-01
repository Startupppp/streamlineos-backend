import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  timesheetPeriods,
  timesheets,
  organizationMembers,
} from "../../../db/schema";
import { actingMembershipId } from "../../../common/auth/principal";
import { PeriodsReadService } from "./periods-read.service";
import { PeriodsSubmitService } from "./periods-submit.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import {
  ApprovalsService,
  lifecyclePayload,
  LIFECYCLE_RETURNING,
  membershipUserIds,
  periodOwnerUserIdOrWarn,
} from "./approvals.service";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { weekRange } from "./lib/period.helpers";
import {
  TIMESHEET_LIFECYCLE_EVENTS,
  emitPeriodLifecycleEvent,
} from "./events/timesheet-lifecycle.events";
import type { PeriodsQuery } from "./dto/periods.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

@Injectable()
export class PeriodsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly reader: PeriodsReadService,
    private readonly submit: PeriodsSubmitService,
    private readonly audit: TimesheetsAuditService,
    private readonly notifications: NotificationDispatchService,
    private readonly approvals: ApprovalsService,
  ) {}

  listPeriods(u: CurrentUserContext, query: PeriodsQuery) {
    return this.reader.listPeriods(u, query);
  }

  getPeriod(u: CurrentUserContext, periodId: number) {
    return this.reader.getPeriod(u, periodId);
  }

  async submitPeriod(u: CurrentUserContext, periodId: number) {
    const { notifyUserIds, ...period } = await this.submit.submitPeriod(u, periodId);

    if (notifyUserIds.length > 0 && period.status === "SUBMITTED") {
      const workerName = ("user" in period && period.user?.name) || "A team member";
      await this.notifications.emit({
        orgId: u.orgId,
        eventKey: "timesheets.period.submitted",
        actorUserId: u.userId,
        targetUserIds: notifyUserIds,
        entityType: "timesheet_period",
        entityId: String(periodId),
        title: `Timesheet submitted: ${period.periodStart} to ${period.periodEnd}`,
        message: `${workerName} submitted their timesheet for ${period.periodStart}–${period.periodEnd} (${period.totalHours}h) and it is waiting for your approval. ${period.approvalRoute?.explanation ?? ""}`.trim(),
        link: `/timesheets/approvals?period=${periodId}`,
        variables: {
          periodId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          totalHours: period.totalHours,
        },
      });
    }

    return period;
  }

  private async findOrCreateCurrentPeriod(orgId: string, userMembershipId: number, workWeekStart: number) {
    const range = weekRange(new Date(), workWeekStart);

    const [existing] = await this.db
      .select({ id: timesheetPeriods.id })
      .from(timesheetPeriods)
      .where(and(
        eq(timesheetPeriods.orgId, orgId),
        eq(timesheetPeriods.userMembershipId, userMembershipId),
        eq(timesheetPeriods.periodStart, range.start),
        eq(timesheetPeriods.periodEnd, range.end),
      ))
      .limit(1);

    if (existing) return existing.id;

    const [created] = await this.db
      .insert(timesheetPeriods)
      .values({
        orgId, userMembershipId,
        periodStart: range.start, periodEnd: range.end,
        status: "OPEN", totalHours: "0", billableHours: "0", nonBillableHours: "0",
      })
      .onConflictDoNothing({
        target: [timesheetPeriods.orgId, timesheetPeriods.userMembershipId, timesheetPeriods.periodStart, timesheetPeriods.periodEnd],
      })
      .returning({ id: timesheetPeriods.id });

    if (created) return created.id;

    const [won] = await this.db
      .select({ id: timesheetPeriods.id })
      .from(timesheetPeriods)
      .where(and(
        eq(timesheetPeriods.orgId, orgId),
        eq(timesheetPeriods.userMembershipId, userMembershipId),
        eq(timesheetPeriods.periodStart, range.start),
        eq(timesheetPeriods.periodEnd, range.end),
      ))
      .limit(1);
    if (!won) throw new Error("Failed to create timesheet period");
    return won.id;
  }

  async getCurrent(u: CurrentUserContext) {
    const membershipId = actingMembershipId(u.principal);
    if (membershipId === null)
      throw new UnprocessableEntityException("Cannot create a period for a non-human session");

    const settings = await this.reader.getSettings(u.orgId);
    const workWeekStart = settings?.workWeekStart ?? 1;
    const periodId = await this.findOrCreateCurrentPeriod(u.orgId, membershipId, workWeekStart);

    const [row, periodEntries] = await Promise.all([
      this.reader.getPeriodWithUser(u.orgId, periodId),
      this.reader.listPeriodEntries(u.orgId, periodId),
    ]);

    if (!row) throw new NotFoundException("Period not found");
    return { period: this.reader.mapPeriod(row), entries: periodEntries };
  }

  async recallPeriod(u: CurrentUserContext, periodId: number) {
    const actorMembId = actingMembershipId(u.principal);
    const row = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");
    if (row.userMembershipId !== actorMembId) throw new ForbiddenException("You can only recall your own period");
    if (row.status !== "SUBMITTED") throw new ConflictException("Only submitted periods can be recalled");

    await this.db.transaction(async (tx) => {
      await tx.update(timesheetPeriods)
        .set({
          status: "DRAFT",
          submittedAt: null,
          currentApproverMembershipId: null,
          approvalRoute: null,
          approvalDueAt: null,
          approvalEscalatedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)));

      await tx.update(timesheets)
        .set({ submittedAt: null, updatedAt: new Date() })
        .where(and(eq(timesheets.timesheetPeriodId, periodId), eq(timesheets.orgId, u.orgId)));

      await this.audit.record(tx, {
        orgId: u.orgId, actorMembershipId: actorMembId,
        entityType: "period", entityId: periodId.toString(), action: "period.recalled",
      });
    });

    const updated = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after recall");
    return this.reader.mapPeriod(updated);
  }

  /**
   * reopen / lock / unlock each move a period through the same state machine
   * that approve and reject do, so they carry the same assigned-approver guard
   * (TS-SEC-002). Holding `timesheets:approvals:manage` previously let anyone
   * reopen, lock or unlock any period in the org, including payroll-bound
   * LOCKED rows routed to a different approver. The org owner override and the
   * delegation path inside canActOnPeriod are unchanged.
   */
  async reopenPeriod(u: CurrentUserContext, periodId: number) {
    const actorMembId = actingMembershipId(u.principal);
    const row = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");
    if (!["APPROVED", "LOCKED"].includes(row.status))
      throw new ConflictException("Only approved or locked periods can be reopened");
    await this.approvals.assertCanActOnPeriod(u, row);

    await this.db.transaction(async (tx) => {
      await tx.update(timesheetPeriods)
        .set({
          status: "DRAFT",
          lockedAt: null,
          approvedAt: null,
          approvedByMembershipId: null,
          currentApproverMembershipId: null,
          approvalRoute: null,
          approvalDueAt: null,
          approvalEscalatedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)));

      await tx.update(timesheets)
        .set({ lockedAt: null, lockedByMembershipId: null, updatedAt: new Date() })
        .where(and(eq(timesheets.timesheetPeriodId, periodId), eq(timesheets.orgId, u.orgId)));

      await this.audit.record(tx, {
        orgId: u.orgId, actorMembershipId: actorMembId,
        entityType: "period", entityId: periodId.toString(), action: "period.reopened",
      });
    });

    const updated = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after reopen");
    return this.reader.mapPeriod(updated);
  }

  async lockPeriod(u: CurrentUserContext, periodId: number) {
    const row = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");
    if (row.status === "LOCKED") {
      return this.reader.mapPeriod(row);
    }
    if (row.status !== "APPROVED") {
      throw new ConflictException("Only approved periods can be locked");
    }
    await this.approvals.assertCanActOnPeriod(u, row);

    const owners = await membershipUserIds(this.db, u.orgId, [row.userMembershipId]);
    const ownerUserId = periodOwnerUserIdOrWarn(owners, row.userMembershipId, {
      orgId: u.orgId,
      periodId,
      operation: "lock",
    });

    const lockedAt = new Date();
    await this.db.transaction(async (tx) => {
      const [actorMember] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.userId, u.userId)))
        .limit(1);
      const lockedByMembershipId = actorMember?.id ?? null;

      const [transition] = await tx
        .update(timesheetPeriods)
        .set({
          status: "LOCKED",
          lockedAt,
          eventSeq: sql`${timesheetPeriods.eventSeq} + 1`,
          updatedAt: lockedAt,
        })
        .where(
          and(
            eq(timesheetPeriods.id, periodId),
            eq(timesheetPeriods.orgId, u.orgId),
            eq(timesheetPeriods.status, "APPROVED"),
          ),
        )
        .returning(LIFECYCLE_RETURNING);

      if (!transition) {
        throw new ConflictException("Only approved periods can be locked");
      }

      await tx
        .update(timesheets)
        .set({ lockedAt, lockedByMembershipId, updatedAt: lockedAt })
        .where(
          and(
            eq(timesheets.timesheetPeriodId, periodId),
            eq(timesheets.orgId, u.orgId),
          ),
        );

      await this.audit.record(tx, {
        orgId: u.orgId, actorMembershipId: lockedByMembershipId,
        entityType: "period", entityId: periodId.toString(), action: "period.locked",
      });

      if (transition && ownerUserId) {
        await emitPeriodLifecycleEvent(tx, {
          eventType: TIMESHEET_LIFECYCLE_EVENTS.locked,
          orgId: u.orgId,
          periodId,
          eventSeq: transition.eventSeq,
          occurredAt: lockedAt,
          payload: lifecyclePayload(u.orgId, periodId, transition, ownerUserId, u.userId, lockedAt, null),
        });
      }
    });

    const updated = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after lock");
    return this.reader.mapPeriod(updated);
  }

  async unlockPeriod(u: CurrentUserContext, periodId: number) {
    const actorMembId = actingMembershipId(u.principal);
    const row = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");
    // Strictly LOCKED: the old compound condition only refused when the status
    // was not LOCKED *and* lockedAt was null, so an APPROVED period carrying a
    // stray lockedAt could be "unlocked" out of a state it was never in.
    // Migration 1705 moved the rows that already had that shape onto LOCKED.
    if (row.status !== "LOCKED") {
      throw new ConflictException("Period is not locked");
    }
    await this.approvals.assertCanActOnPeriod(u, row);

    await this.db.transaction(async (tx) => {
      const [transition] = await tx.update(timesheetPeriods)
        .set({ status: "APPROVED", lockedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(timesheetPeriods.id, periodId),
            eq(timesheetPeriods.orgId, u.orgId),
            eq(timesheetPeriods.status, "LOCKED"),
          ),
        )
        .returning({ id: timesheetPeriods.id });
      if (!transition) throw new ConflictException("Period is not locked");

      await tx.update(timesheets)
        .set({ lockedAt: null, lockedByMembershipId: null, updatedAt: new Date() })
        .where(and(eq(timesheets.timesheetPeriodId, periodId), eq(timesheets.orgId, u.orgId)));

      await this.audit.record(tx, {
        orgId: u.orgId, actorMembershipId: actorMembId,
        entityType: "period", entityId: periodId.toString(), action: "period.unlocked",
      });
    });

    const updated = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after unlock");
    return this.reader.mapPeriod(updated);
  }
}
