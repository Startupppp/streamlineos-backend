import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  timesheetPeriods,
  timesheets,
  timesheetSettings,
  users,
  projects,
} from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { applyScope } from "../../access/apply-scope";
import { resolveEntriesScope } from "./timesheets-core-scope";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { EntriesService } from "./entries.service";
import { weekRange } from "./lib/period.helpers";
import {
  TIMESHEET_LIFECYCLE_EVENTS,
  emitPeriodLifecycleEvent,
} from "./events/timesheet-lifecycle.events";
import type { PeriodsQuery } from "./dto/periods.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

/**
 * Everything a lifecycle event needs, returned by the UPDATE that performs the
 * transition. Selecting it separately would race: `event_seq` is only correct
 * as read back from the statement that incremented it.
 */
const LIFECYCLE_RETURNING = {
  eventSeq: timesheetPeriods.eventSeq,
  userId: timesheetPeriods.userId,
  periodStart: timesheetPeriods.periodStart,
  periodEnd: timesheetPeriods.periodEnd,
  status: timesheetPeriods.status,
  totalHours: timesheetPeriods.totalHours,
  billableHours: timesheetPeriods.billableHours,
  nonBillableHours: timesheetPeriods.nonBillableHours,
} as const;

@Injectable()
export class PeriodsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly entries: EntriesService,
    private readonly audit: TimesheetsAuditService,
    private readonly notifications: NotificationDispatchService,
  ) {}

  private async getSettings(orgId: string) {
    const [s] = await this.db
      .select()
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, orgId))
      .limit(1);
    return s;
  }

  private async getPeriodWithUser(orgId: string, periodId: number) {
    const rows = await this.db
      .select({
        id: timesheetPeriods.id,
        orgId: timesheetPeriods.orgId,
        userId: timesheetPeriods.userId,
        periodStart: timesheetPeriods.periodStart,
        periodEnd: timesheetPeriods.periodEnd,
        status: timesheetPeriods.status,
        totalHours: timesheetPeriods.totalHours,
        billableHours: timesheetPeriods.billableHours,
        nonBillableHours: timesheetPeriods.nonBillableHours,
        submittedAt: timesheetPeriods.submittedAt,
        approvedAt: timesheetPeriods.approvedAt,
        rejectedAt: timesheetPeriods.rejectedAt,
        lockedAt: timesheetPeriods.lockedAt,
        currentApproverId: timesheetPeriods.currentApproverId,
        approvedBy: timesheetPeriods.approvedBy,
        rejectionReason: timesheetPeriods.rejectionReason,
        createdAt: timesheetPeriods.createdAt,
        updatedAt: timesheetPeriods.updatedAt,
        userEmail: users.email,
        userName: users.name,
      })
      .from(timesheetPeriods)
      .leftJoin(users, eq(timesheetPeriods.userId, users.id))
      .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, orgId)));

    return rows[0] ?? null;
  }

  private mapPeriod(row: {
    id: number;
    orgId: string;
    userId: string;
    periodStart: string;
    periodEnd: string;
    status: string;
    totalHours: string;
    billableHours: string;
    nonBillableHours: string;
    submittedAt: Date | null;
    approvedAt: Date | null;
    rejectedAt: Date | null;
    lockedAt: Date | null;
    currentApproverId: string | null;
    approvedBy: string | null;
    rejectionReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    userEmail?: string | null;
    userName?: string | null;
  }) {
    return {
      id: row.id,
      orgId: row.orgId,
      userId: row.userId,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      status: row.status,
      totalHours: row.totalHours,
      billableHours: row.billableHours,
      nonBillableHours: row.nonBillableHours,
      submittedAt: row.submittedAt,
      approvedAt: row.approvedAt,
      rejectedAt: row.rejectedAt,
      lockedAt: row.lockedAt,
      currentApproverId: row.currentApproverId,
      rejectionReason: row.rejectionReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.userEmail
        ? { user: { id: row.userId, name: row.userName ?? row.userEmail, email: row.userEmail } }
        : {}),
    };
  }

  async listPeriods(u: CurrentUserContext, query: PeriodsQuery) {
    const scope = await resolveEntriesScope(this.access, u);
    const limit = Math.min(query.limit, 100);

    const conditions = [
      eq(timesheetPeriods.orgId, u.orgId),
      applyScope(scope, u.orgId, u.userId, { ownerColumn: timesheetPeriods.userId }),
    ];

    if (query.userId && scope === "all") {
      conditions.push(eq(timesheetPeriods.userId, query.userId));
    }
    if (query.status) conditions.push(eq(timesheetPeriods.status, query.status));

    const rows = await this.db
      .select({
        id: timesheetPeriods.id,
        orgId: timesheetPeriods.orgId,
        userId: timesheetPeriods.userId,
        periodStart: timesheetPeriods.periodStart,
        periodEnd: timesheetPeriods.periodEnd,
        status: timesheetPeriods.status,
        totalHours: timesheetPeriods.totalHours,
        billableHours: timesheetPeriods.billableHours,
        nonBillableHours: timesheetPeriods.nonBillableHours,
        submittedAt: timesheetPeriods.submittedAt,
        approvedAt: timesheetPeriods.approvedAt,
        rejectedAt: timesheetPeriods.rejectedAt,
        lockedAt: timesheetPeriods.lockedAt,
        currentApproverId: timesheetPeriods.currentApproverId,
        approvedBy: timesheetPeriods.approvedBy,
        rejectionReason: timesheetPeriods.rejectionReason,
        createdAt: timesheetPeriods.createdAt,
        updatedAt: timesheetPeriods.updatedAt,
        userEmail: users.email,
        userName: users.name,
      })
      .from(timesheetPeriods)
      .leftJoin(users, eq(timesheetPeriods.userId, users.id))
      .where(and(...conditions))
      .orderBy(desc(timesheetPeriods.periodStart))
      .limit(limit);

    return rows.map((r) => this.mapPeriod(r));
  }

  private async findOrCreateCurrentPeriod(orgId: string, userId: string, workWeekStart: number) {
    const range = weekRange(new Date(), workWeekStart);

    const [existing] = await this.db
      .select({ id: timesheetPeriods.id })
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.orgId, orgId),
          eq(timesheetPeriods.userId, userId),
          eq(timesheetPeriods.periodStart, range.start),
          eq(timesheetPeriods.periodEnd, range.end),
        ),
      )
      .limit(1);

    if (existing) return existing.id;

    const [created] = await this.db
      .insert(timesheetPeriods)
      .values({
        orgId,
        userId,
        periodStart: range.start,
        periodEnd: range.end,
        status: "OPEN",
        totalHours: "0",
        billableHours: "0",
        nonBillableHours: "0",
      })
      .returning({ id: timesheetPeriods.id });

    if (!created) throw new Error("Failed to create timesheet period");
    return created.id;
  }

  async getCurrent(u: CurrentUserContext) {
    const settings = await this.getSettings(u.orgId);
    const workWeekStart = settings?.workWeekStart ?? 1;
    const periodId = await this.findOrCreateCurrentPeriod(u.orgId, u.userId, workWeekStart);

    const [row, periodEntries] = await Promise.all([
      this.getPeriodWithUser(u.orgId, periodId),
      this.db.query.timesheets.findMany({
        where: and(
          eq(timesheets.timesheetPeriodId, periodId),
          eq(timesheets.orgId, u.orgId),
        ),
        orderBy: [desc(timesheets.date)],
      }),
    ]);

    if (!row) throw new NotFoundException("Period not found");

    return { period: this.mapPeriod(row), entries: periodEntries };
  }

  async getPeriod(u: CurrentUserContext, periodId: number) {
    const row = await this.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");

    const scope = await resolveEntriesScope(this.access, u);
    const canSeeOthers =
      u.isOrgOwner ||
      scope === "all" ||
      scope === "team";

    if (row.userId !== u.userId && !canSeeOthers) {
      throw new ForbiddenException("You do not have access to this period");
    }

    const periodEntries = await this.db.query.timesheets.findMany({
      where: and(
        eq(timesheets.timesheetPeriodId, periodId),
        eq(timesheets.orgId, u.orgId),
      ),
      orderBy: [desc(timesheets.date)],
    });

    return { period: this.mapPeriod(row), entries: periodEntries };
  }

  async submitPeriod(u: CurrentUserContext, periodId: number) {
    const row = await this.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");
    if (row.userId !== u.userId) throw new ForbiddenException("You can only submit your own period");
    if (!["OPEN", "DRAFT"].includes(row.status)) {
      throw new ConflictException("Only open or draft periods can be submitted");
    }

    const settings = await this.getSettings(u.orgId);
    const requiredFields = (settings?.requiredFields as string[] | null) ?? [];

    const periodEntries = await this.db.query.timesheets.findMany({
      where: and(
        eq(timesheets.timesheetPeriodId, periodId),
        eq(timesheets.orgId, u.orgId),
        isNull(timesheets.voidedAt),
      ),
    });

    for (const entry of periodEntries) {
      if (requiredFields.includes("description") && !entry.description) {
        throw new BadRequestException(`Entry ${entry.id} is missing a required description`);
      }
      if (requiredFields.includes("project") && !entry.projectId && !entry.ticketId) {
        throw new BadRequestException(`Entry ${entry.id} is missing a required project`);
      }
    }

    const approverId = await this.resolveApproverId(u.orgId, periodEntries);

    await this.entries.recomputePeriodTotals(u.orgId, periodId);

    const submittedAt = new Date();
    await this.db.transaction(async (tx) => {
      const [transition] = await tx
        .update(timesheetPeriods)
        .set({
          status: "SUBMITTED",
          submittedAt,
          currentApproverId: approverId,
          eventSeq: sql`${timesheetPeriods.eventSeq} + 1`,
          updatedAt: submittedAt,
        })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)))
        .returning(LIFECYCLE_RETURNING);

      await tx
        .update(timesheets)
        .set({ submittedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(timesheets.timesheetPeriodId, periodId),
            eq(timesheets.orgId, u.orgId),
            isNull(timesheets.voidedAt),
          ),
        );

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "period",
        entityId: periodId.toString(),
        action: "period.submitted",
        after: { status: "SUBMITTED" },
      });

      /**
       * In the transaction, so a submitted period can never exist without its
       * event and an event can never announce a submission that rolled back.
       * `transition` is absent only when the UPDATE matched nothing, which the
       * guards above have already ruled out — but a silent emit for a period
       * that was not updated would be worse than no emit, so it is checked.
       */
      if (transition) {
        await emitPeriodLifecycleEvent(tx, {
          eventType: TIMESHEET_LIFECYCLE_EVENTS.submitted,
          orgId: u.orgId,
          periodId,
          eventSeq: transition.eventSeq,
          occurredAt: submittedAt,
          payload: {
            organization_id: u.orgId,
            period_id: periodId,
            user_id: transition.userId,
            period_start: transition.periodStart,
            period_end: transition.periodEnd,
            status: transition.status,
            total_hours: transition.totalHours,
            billable_hours: transition.billableHours,
            non_billable_hours: transition.nonBillableHours,
            actor_user_id: u.userId,
            reason: null,
            occurred_at: submittedAt.toISOString(),
          },
        });
      }
    });

    const updated = await this.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after submit");

    /**
     * TS-24. The approver hears about it, through the existing notification
     * pipeline and therefore the existing email outbox — no second mailer.
     *
     * After the transaction, not inside it. `emit` writes its intent onto the
     * *request's* transaction and drains it via `registerAfterCommit`, and this
     * method's `db.transaction` is a savepoint on that same request
     * transaction — so calling it here is both simpler to read and drains on
     * the same commit either way.
     *
     * Silent when there is no approver. `resolveApproverId` answers null for a
     * period with no project work on it, and there is no honest fallback:
     * broadcasting an unrouted timesheet to every manager is worse than the
     * approvals queue being the only place it shows up.
     */
    if (approverId) {
      await this.notifications.emit({
        orgId: u.orgId,
        eventKey: "timesheets.period.submitted",
        actorUserId: u.userId,
        targetUserIds: [approverId],
        entityType: "timesheet_period",
        entityId: String(periodId),
        title: `Timesheet submitted: ${row.periodStart} to ${row.periodEnd}`,
        message: `${updated.userName ?? updated.userEmail ?? "A team member"} submitted their timesheet for ${row.periodStart}–${row.periodEnd} (${updated.totalHours}h) and it is waiting for your approval.`,
        link: `/timesheets/approvals?period=${periodId}`,
        variables: {
          periodId,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          totalHours: updated.totalHours,
        },
      });
    }

    return this.mapPeriod(updated);
  }

  private async resolveApproverId(orgId: string, entries: { projectId: number | null; ticketId: number | null }[]): Promise<string | null> {
    const projectIds = entries
      .map((e) => e.projectId)
      .filter((id): id is number => id !== null);

    if (projectIds.length === 0) return null;

    const freq = new Map<number, number>();
    for (const id of projectIds) freq.set(id, (freq.get(id) ?? 0) + 1);
    const topId = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!topId) return null;

    const [proj] = await this.db
      .select({ managerId: projects.managerId })
      .from(projects)
      .where(and(eq(projects.id, topId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .limit(1);

    return proj?.managerId ?? null;
  }

  async recallPeriod(u: CurrentUserContext, periodId: number) {
    const row = await this.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");
    if (row.userId !== u.userId) throw new ForbiddenException("You can only recall your own period");
    if (row.status !== "SUBMITTED") throw new ConflictException("Only submitted periods can be recalled");

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheetPeriods)
        .set({ status: "DRAFT", submittedAt: null, updatedAt: new Date() })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)));

      await tx
        .update(timesheets)
        .set({ submittedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(timesheets.timesheetPeriodId, periodId),
            eq(timesheets.orgId, u.orgId),
          ),
        );

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "period",
        entityId: periodId.toString(),
        action: "period.recalled",
      });
    });

    const updated = await this.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after recall");
    return this.mapPeriod(updated);
  }

  async reopenPeriod(u: CurrentUserContext, periodId: number) {
    const row = await this.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");
    if (!["APPROVED", "LOCKED"].includes(row.status)) {
      throw new ConflictException("Only approved or locked periods can be reopened");
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheetPeriods)
        .set({
          status: "DRAFT",
          lockedAt: null,
          approvedAt: null,
          approvedBy: null,
          updatedAt: new Date(),
        })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)));

      await tx
        .update(timesheets)
        .set({ lockedAt: null, lockedBy: null, updatedAt: new Date() })
        .where(
          and(
            eq(timesheets.timesheetPeriodId, periodId),
            eq(timesheets.orgId, u.orgId),
          ),
        );

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "period",
        entityId: periodId.toString(),
        action: "period.reopened",
      });
    });

    const updated = await this.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after reopen");
    return this.mapPeriod(updated);
  }

  async lockPeriod(u: CurrentUserContext, periodId: number) {
    const row = await this.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");

    const lockedAt = new Date();
    await this.db.transaction(async (tx) => {
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
        .set({ lockedAt, lockedBy: u.userId, updatedAt: lockedAt })
        .where(
          and(
            eq(timesheets.timesheetPeriodId, periodId),
            eq(timesheets.orgId, u.orgId),
          ),
        );

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "period",
        entityId: periodId.toString(),
        action: "period.locked",
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
       */
      if (transition) {
        await emitPeriodLifecycleEvent(tx, {
          eventType: TIMESHEET_LIFECYCLE_EVENTS.locked,
          orgId: u.orgId,
          periodId,
          eventSeq: transition.eventSeq,
          occurredAt: lockedAt,
          payload: {
            organization_id: u.orgId,
            period_id: periodId,
            user_id: transition.userId,
            period_start: transition.periodStart,
            period_end: transition.periodEnd,
            status: transition.status,
            total_hours: transition.totalHours,
            billable_hours: transition.billableHours,
            non_billable_hours: transition.nonBillableHours,
            actor_user_id: u.userId,
            reason: null,
            occurred_at: lockedAt.toISOString(),
          },
        });
      }
    });

    const updated = await this.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after lock");
    return this.mapPeriod(updated);
  }

  async unlockPeriod(u: CurrentUserContext, periodId: number) {
    const row = await this.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheetPeriods)
        .set({ lockedAt: null, updatedAt: new Date() })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)));

      await tx
        .update(timesheets)
        .set({ lockedAt: null, lockedBy: null, updatedAt: new Date() })
        .where(
          and(
            eq(timesheets.timesheetPeriodId, periodId),
            eq(timesheets.orgId, u.orgId),
          ),
        );

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "period",
        entityId: periodId.toString(),
        action: "period.unlocked",
      });
    });

    const updated = await this.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after unlock");
    return this.mapPeriod(updated);
  }
}
