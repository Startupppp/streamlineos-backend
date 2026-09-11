import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import {
  and,
  desc,
  sql,
  gt,
  eq,
  gte,
  inArray,
  isNull,
  lte,
} from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { logger } from "../../../common/logger/logger.service";
import { type Db } from "../../../db/drizzle.module";
import { alias } from "drizzle-orm/pg-core";
import {
  organizationMembers,
  timesheetPeriods,
  timesheets,
  timesheetSettings,
  userDelegations,
  users,
} from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { applyScope } from "../../access/apply-scope";
import { resolveApprovalScope } from "./timesheets-core-scope";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { RateResolverService } from "./rate-resolver.service";
import { canActOnPeriod } from "./lib/approval-guard";
import {
  TIMESHEET_LIFECYCLE_EVENTS,
  emitPeriodLifecycleEvent,
  type PeriodLifecycleEvent,
} from "./events/timesheet-lifecycle.events";

import type {
  ApprovalsQuery,
  BulkApproveInput,
  BulkRejectInput,
  RejectPeriodInput,
} from "./dto/approvals.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

/**
 * Everything a lifecycle event needs, returned by the UPDATE that performs the
 * transition. `event_seq` is only correct as read back from the statement that
 * incremented it — selecting it separately races another transition.
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

type LifecycleRow = {
  userId: string;
  periodStart: string;
  periodEnd: string;
  status: PeriodLifecycleEvent["status"];
  totalHours: string;
  billableHours: string;
  nonBillableHours: string;
};

function lifecyclePayload(
  orgId: string,
  periodId: number,
  row: LifecycleRow,
  actorUserId: string,
  occurredAt: Date,
  reason: string | null,
): PeriodLifecycleEvent {
  return {
    organization_id: orgId,
    period_id: periodId,
    user_id: row.userId,
    period_start: row.periodStart,
    period_end: row.periodEnd,
    status: row.status,
    total_hours: row.totalHours,
    billable_hours: row.billableHours,
    non_billable_hours: row.nonBillableHours,
    actor_user_id: actorUserId,
    reason,
    occurred_at: occurredAt.toISOString(),
  };
}

function isExpectedApprovalSkip(error: unknown): boolean {
  return (
    error instanceof ConflictException ||
    error instanceof NotFoundException ||
    error instanceof ForbiddenException ||
    error instanceof BadRequestException
  );
}

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: TimesheetsAuditService,
    private readonly rateResolver: RateResolverService,
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

  /** True when `approverId` has an active, unexpired delegation to the actor. */
  private async hasActiveDelegation(
    orgId: string,
    approverId: string,
    actorUserId: string,
  ): Promise<boolean> {
    const delegatorMember = alias(organizationMembers, "delegation_delegator");
    const delegateeMember = alias(organizationMembers, "delegation_delegatee");
    const [row] = await this.db
      .select({ id: userDelegations.id })
      .from(userDelegations)
      .innerJoin(
        delegatorMember,
        and(
          eq(delegatorMember.orgId, userDelegations.orgId),
          eq(delegatorMember.id, userDelegations.delegatorMembershipId),
        ),
      )
      .innerJoin(
        delegateeMember,
        and(
          eq(delegateeMember.orgId, userDelegations.orgId),
          eq(delegateeMember.id, userDelegations.delegateeMembershipId),
        ),
      )
      .where(
        and(
          eq(userDelegations.orgId, orgId),
          eq(delegatorMember.userId, approverId),
          eq(delegateeMember.userId, actorUserId),
          eq(userDelegations.status, "ACTIVE"),
          lte(userDelegations.startsAt, new Date()),
          gt(userDelegations.endsAt, new Date()),
        ),
      )
      .limit(1);
    return !!row;
  }

  private async assertCanActOnPeriod(
    u: CurrentUserContext,
    period: { userId: string; currentApproverId: string | null },
  ): Promise<void> {
    const actor = {
      userId: u.userId,
      isOrgOwner: !!u.isOrgOwner,
    };

    let delegateeOfApprover = false;
    if (
      period.currentApproverId &&
      period.currentApproverId !== u.userId &&
      period.userId !== u.userId
    ) {
      delegateeOfApprover = await this.hasActiveDelegation(
        u.orgId,
        period.currentApproverId,
        u.userId,
      );
    }

    const decision = canActOnPeriod(actor, period, { delegateeOfApprover });
    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason);
    }
  }

  async listApprovals(u: CurrentUserContext, query: ApprovalsQuery) {
    const scope = await resolveApprovalScope(this.access, u);
    const limit = Math.min(query.limit, 100);
    const offset = (query.page - 1) * limit;
    const conditions = [
      eq(timesheetPeriods.orgId, u.orgId),
      eq(timesheetPeriods.status, query.status),
      applyScope(scope, u.orgId, u.userId, { ownerColumn: timesheetPeriods.userId }),
    ];

    if (
      query.userId &&
      (scope === "all" || u.isOrgOwner)
    ) {
      conditions.push(eq(timesheetPeriods.userId, query.userId));
    }
    if (query.startDate) {
      conditions.push(gte(timesheetPeriods.periodStart, query.startDate));
    }
    if (query.endDate) {
      conditions.push(lte(timesheetPeriods.periodEnd, query.endDate));
    }

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
        windowTotal: sql<string>`count(*) OVER ()`,
      })
      .from(timesheetPeriods)
      .leftJoin(users, eq(timesheetPeriods.userId, users.id))
      .where(and(...conditions))
      .orderBy(desc(timesheetPeriods.submittedAt))
      .limit(limit)
      .offset(offset);

    const firstRow = rows[0];
    let paginationTotal: number;
    if (firstRow) {
      paginationTotal = Number(firstRow.windowTotal);
    } else if (offset === 0) {
      paginationTotal = 0;
    } else {
      const fallback = await this.db
        .select({ n: sql<string>`count(*)` })
        .from(timesheetPeriods)
        .where(and(...conditions));
      paginationTotal = Number(fallback[0]?.n ?? 0);
    }

    const data = rows.map(({ windowTotal: _w, ...r }) => ({
      ...r,
      user: {
        id: r.userId,
        name: r.userName ?? r.userEmail,
        email: r.userEmail,
      },
    }));

    return {
      data,
      pagination: {
        page: query.page,
        limit,
        total: paginationTotal,
      },
    };
  }

  private async approveSinglePeriod(u: CurrentUserContext, periodId: number) {
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

    if (!period) throw new NotFoundException(`Period ${periodId} not found`);
    if (period.status !== "SUBMITTED") {
      throw new ConflictException(
        `Period ${periodId} is not in SUBMITTED state`,
      );
    }
    await this.assertCanActOnPeriod(u, period);

    const approverActor = await assertOrganizationActor(this.db, u.orgId, { kind: "user", userId: u.userId }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    });

    const settings = await this.getSettings(u.orgId);
    const lockAfterApproval = settings?.lockAfterApproval ?? true;
    const now = new Date();

    /**
     * One transition, but up to two events: approving with
     * `lock_after_approval` on also locks, and the pack's payroll handoff waits
     * on `timesheets.period.locked` specifically. Both events therefore need
     * their own `aggregate_version`, and they share a single `now` — which is
     * exactly why the version is a row counter and not a timestamp. The UPDATE
     * claims both numbers at once so nothing can be interleaved between them.
     */
    const emitCount = lockAfterApproval ? 2 : 1;

    await this.db.transaction(async (tx) => {
      const [transition] = await tx
        .update(timesheetPeriods)
        .set({
          status: "APPROVED",
          approvedAt: now,
          approvedBy: u.userId,
          approvedByMembershipId: approverActor.membershipId,
          lockedAt: lockAfterApproval ? now : null,
          eventSeq: sql`${timesheetPeriods.eventSeq} + ${emitCount}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(timesheetPeriods.id, periodId),
            eq(timesheetPeriods.orgId, u.orgId),
          ),
        )
        .returning(LIFECYCLE_RETURNING);

      await tx
        .update(timesheets)
        .set({
          status: "APPROVED",
          approvedBy: u.userId,
          approvedByMembershipId: approverActor.membershipId,
          approvedAt: now,
          lockedAt: lockAfterApproval ? now : null,
          lockedBy: lockAfterApproval ? u.userId : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(timesheets.timesheetPeriodId, periodId),
            eq(timesheets.orgId, u.orgId),
            isNull(timesheets.voidedAt),
          ),
        );

      const billableEntries = await tx
        .select()
        .from(timesheets)
        .where(
          and(
            eq(timesheets.timesheetPeriodId, periodId),
            eq(timesheets.orgId, u.orgId),
            eq(timesheets.isBillable, true),
            isNull(timesheets.billRate),
            isNull(timesheets.voidedAt),
          ),
        );

      const resolvedRates = await this.rateResolver.resolveMany(
        u.orgId,
        billableEntries.map((entry) => ({
          projectId: entry.projectId,
          userId: entry.userId,
          ticketId: entry.ticketId,
          date: entry.date,
        })),
      );

      type RateGroup = { billRate: string; costRate: string | null; currency: string; rateSource: typeof resolvedRates[number]["source"]; ids: number[] };
      const rateGroups = new Map<string, RateGroup>();
      for (const [i, entry] of billableEntries.entries()) {
        const resolved = resolvedRates[i];
        if (!resolved || resolved.billRate === null) continue;
        const groupKey = `${resolved.billRate}:${resolved.costRate ?? ""}:${resolved.currency}:${resolved.source ?? ""}`;
        const group = rateGroups.get(groupKey) ?? {
          billRate: resolved.billRate.toString(),
          costRate: resolved.costRate !== null ? resolved.costRate.toString() : null,
          currency: resolved.currency,
          rateSource: resolved.source,
          ids: [],
        };
        group.ids.push(entry.id);
        rateGroups.set(groupKey, group);
      }

      for (const group of rateGroups.values()) {
        await tx
          .update(timesheets)
          .set({
            billRate: group.billRate,
            costRate: group.costRate,
            currency: group.currency,
            rateSource: group.rateSource,
            updatedAt: now,
          })
          .where(
            and(
              eq(timesheets.orgId, u.orgId),
              inArray(timesheets.id, group.ids),
            ),
          );
      }

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "period",
        entityId: periodId.toString(),
        action: "period.approved",
        after: { status: "APPROVED" },
      });

      if (transition) {
        const base = transition.eventSeq - emitCount + 1;
        const payload = lifecyclePayload(u.orgId, periodId, transition, u.userId, now, null);

        await emitPeriodLifecycleEvent(tx, {
          eventType: TIMESHEET_LIFECYCLE_EVENTS.approved,
          orgId: u.orgId,
          periodId,
          eventSeq: base,
          occurredAt: now,
          payload,
        });

        if (lockAfterApproval) {
          await emitPeriodLifecycleEvent(tx, {
            eventType: TIMESHEET_LIFECYCLE_EVENTS.locked,
            orgId: u.orgId,
            periodId,
            eventSeq: transition.eventSeq,
            occurredAt: now,
            payload,
          });
        }
      }
    });

    /**
     * TS-24. The worker hears that their week was signed off, through the
     * existing notification pipeline and therefore the existing email outbox.
     *
     * `notifySelf` is left at its default, so an approver approving their own
     * period — which `canActOnPeriod` allows an org owner to do — is not
     * emailed about their own click.
     */
    await this.notifications.emit({
      orgId: u.orgId,
      eventKey: "timesheets.period.approved",
      actorUserId: u.userId,
      targetUserIds: [period.userId],
      entityType: "timesheet_period",
      entityId: String(periodId),
      title: `Timesheet approved: ${period.periodStart} to ${period.periodEnd}`,
      message: `Your timesheet for ${period.periodStart}–${period.periodEnd} (${period.totalHours}h) was approved.`,
      link: `/timesheets/my-time?period=${periodId}`,
      variables: {
        periodId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        totalHours: period.totalHours,
      },
    });
  }

  async approvePeriod(u: CurrentUserContext, periodId: number) {
    await this.approveSinglePeriod(u, periodId);

    const [updated] = await this.db
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
      .where(
        and(
          eq(timesheetPeriods.id, periodId),
          eq(timesheetPeriods.orgId, u.orgId),
        ),
      )
      .limit(1);

    return updated;
  }

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
    await this.assertCanActOnPeriod(u, period);

    const now = new Date();
    await this.db.transaction(async (tx) => {
      const [transition] = await tx
        .update(timesheetPeriods)
        .set({
          status: "REJECTED",
          rejectedAt: now,
          rejectionReason: input.reason,
          eventSeq: sql`${timesheetPeriods.eventSeq} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(timesheetPeriods.id, periodId),
            eq(timesheetPeriods.orgId, u.orgId),
          ),
        )
        .returning(LIFECYCLE_RETURNING);

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
        actorUserId: u.userId,
        entityType: "period",
        entityId: periodId.toString(),
        action: "period.rejected",
        reason: input.reason,
      });

      if (transition) {
        await emitPeriodLifecycleEvent(tx, {
          eventType: TIMESHEET_LIFECYCLE_EVENTS.rejected,
          orgId: u.orgId,
          periodId,
          eventSeq: transition.eventSeq,
          occurredAt: now,
          payload: lifecyclePayload(
            u.orgId,
            periodId,
            transition,
            u.userId,
            now,
            input.reason,
          ),
        });
      }
    });

    await this.notifications.emit({
      orgId: u.orgId,
      eventKey: "timesheets.period.rejected",
      actorUserId: u.userId,
      targetUserIds: [period.userId],
      entityType: "timesheet_period",
      entityId: String(periodId),
      title: `Timesheet rejected: ${period.periodStart} to ${period.periodEnd}`,
      message: `Your timesheet for ${period.periodStart}–${period.periodEnd} was rejected: ${input.reason}`,
      link: `/timesheets/my-time?period=${periodId}`,
      variables: {
        periodId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        reason: input.reason,
      },
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

  async bulkApprove(u: CurrentUserContext, input: BulkApproveInput) {
    let approved = 0;
    let skipped = 0;
    for (const periodId of input.periodIds) {
      try {
        await this.approveSinglePeriod(u, periodId);
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
        userId: timesheetPeriods.userId,
        currentApproverId: timesheetPeriods.currentApproverId,
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
        await this.assertCanActOnPeriod(u, p);
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
      const transitions = await tx
        .update(timesheetPeriods)
        .set({
          status: "REJECTED",
          rejectedAt: now,
          rejectionReason: input.reason,
          eventSeq: sql`${timesheetPeriods.eventSeq} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(timesheetPeriods.orgId, u.orgId),
            inArray(timesheetPeriods.id, ids),
          ),
        )
        .returning({ ...LIFECYCLE_RETURNING, id: timesheetPeriods.id });

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

      for (const id of ids) {
        await this.audit.record(tx, {
          orgId: u.orgId,
          actorUserId: u.userId,
          entityType: "period",
          entityId: id.toString(),
          action: "period.rejected",
          reason: input.reason,
        });
      }

      /**
       * One event per period, not one for the batch. A bulk rejection is a
       * convenience for the approver; to everyone downstream it is N separate
       * things that happened to N separate people, and an event whose
       * `period_id` is a list is unroutable.
       */
      for (const transition of transitions) {
        await emitPeriodLifecycleEvent(tx, {
          eventType: TIMESHEET_LIFECYCLE_EVENTS.rejected,
          orgId: u.orgId,
          periodId: transition.id,
          eventSeq: transition.eventSeq,
          occurredAt: now,
          payload: lifecyclePayload(
            u.orgId,
            transition.id,
            transition,
            u.userId,
            now,
            input.reason,
          ),
        });
      }
    });

    /**
     * One notification per worker, after the batch commits. A bulk rejection is
     * one action for the approver and N separate pieces of bad news for N
     * people, each of whom needs the reason and their own period link.
     */
    for (const p of periods) {
      await this.notifications.emit({
        orgId: u.orgId,
        eventKey: "timesheets.period.rejected",
        actorUserId: u.userId,
        targetUserIds: [p.userId],
        entityType: "timesheet_period",
        entityId: String(p.id),
        title: "Timesheet rejected",
        message: `Your submitted timesheet was rejected: ${input.reason}`,
        link: `/timesheets/my-time?period=${p.id}`,
        variables: { periodId: p.id, reason: input.reason },
      });
    }

    return { rejected: ids.length };
  }
}
