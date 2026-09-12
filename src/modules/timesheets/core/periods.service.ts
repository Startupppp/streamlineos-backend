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
  ) {}

  listPeriods(u: CurrentUserContext, query: PeriodsQuery) {
    return this.reader.listPeriods(u, query);
  }

  getPeriod(u: CurrentUserContext, periodId: number) {
    return this.reader.getPeriod(u, periodId);
  }

  async submitPeriod(u: CurrentUserContext, periodId: number) {
    const period = await this.submit.submitPeriod(u, periodId);

    /**
     * TS-24. The approver hears about it, through the existing notification
     * pipeline and therefore the existing email outbox — no second mailer.
     *
     * After the submit's transaction, not inside it: `PeriodsSubmitService`
     * writes the lifecycle event inside the transaction, and this announces
     * the committed result. `emit` writes its intent onto the request's
     * transaction and drains it via `registerAfterCommit`, so it drains on the
     * same commit either way.
     *
     * Silent when there is no approver. The approver is the manager of the
     * period's main project, which is null for a period with no project work
     * on it, and there is no honest fallback: broadcasting an unrouted
     * timesheet to every manager is worse than the approvals queue being the
     * only place it shows up.
     */
    const approverMembershipId = period.currentApproverMembershipId;
    if (approverMembershipId !== null) {
      const approvers = await membershipUserIds(this.db, u.orgId, [approverMembershipId]);
      const approverUserId = approvers.get(approverMembershipId);
      if (approverUserId) {
        const workerName = ("user" in period && period.user?.name) || "A team member";
        await this.notifications.emit({
          orgId: u.orgId,
          eventKey: "timesheets.period.submitted",
          actorUserId: u.userId,
          targetUserIds: [approverUserId],
          entityType: "timesheet_period",
          entityId: String(periodId),
          title: `Timesheet submitted: ${period.periodStart} to ${period.periodEnd}`,
          message: `${workerName} submitted their timesheet for ${period.periodStart}–${period.periodEnd} (${period.totalHours}h) and it is waiting for your approval.`,
          link: `/timesheets/approvals?period=${periodId}`,
          variables: {
            periodId,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            totalHours: period.totalHours,
          },
        });
      }
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

    /*
     * Two requests for the current week can both miss the read above — two
     * tabs, a StrictMode double fetch — and the second insert used to die on
     * `uniq_timesheet_periods_user_membership_range` as a 500. The conflict is
     * the other request having won, so it is read back rather than raised.
     */
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
      this.db.query.timesheets.findMany({
        where: and(eq(timesheets.timesheetPeriodId, periodId), eq(timesheets.orgId, u.orgId)),
        orderBy: [desc(timesheets.date)],
      }),
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
        .set({ status: "DRAFT", submittedAt: null, updatedAt: new Date() })
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

  async reopenPeriod(u: CurrentUserContext, periodId: number) {
    const actorMembId = actingMembershipId(u.principal);
    const row = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");
    if (!["APPROVED", "LOCKED"].includes(row.status))
      throw new ConflictException("Only approved or locked periods can be reopened");

    await this.db.transaction(async (tx) => {
      await tx.update(timesheetPeriods)
        .set({ status: "DRAFT", lockedAt: null, approvedAt: null, approvedByMembershipId: null, updatedAt: new Date() })
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
          lockedAt,
          eventSeq: sql`${timesheetPeriods.eventSeq} + 1`,
          updatedAt: lockedAt,
        })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)))
        .returning(LIFECYCLE_RETURNING);

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

      /**
       * TS-05. `timesheets.period.locked` is the event the payroll side of the
       * pack waits on, and it is emitted here rather than after the commit for
       * the usual reason: a lock that announced itself and then rolled back
       * would hand payroll a window it could act on.
       *
       * Note what `status` carries — whatever the period already had, usually
       * APPROVED. `lockPeriod` writes `locked_at` and does not write the
       * `LOCKED` status the enum declares, so the event reports the row as it
       * actually is rather than as the name suggests. Recorded as a finding;
       * changing it is a decision about what "locked" means, not a detail to
       * fix inside an emit.
       *
       * A period whose worker's membership no longer resolves is still locked
       * but announces nothing, so payroll does not hear about it; the skip is
       * logged by `periodOwnerUserIdOrWarn` for an operator to reconcile.
       */
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

    await this.db.transaction(async (tx) => {
      await tx.update(timesheetPeriods)
        .set({ lockedAt: null, updatedAt: new Date() })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)));

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
