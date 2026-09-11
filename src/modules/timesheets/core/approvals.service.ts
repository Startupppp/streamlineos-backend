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
import { and, desc, gt, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
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
import { actingMembershipId } from "../../../common/auth/principal";
import { resolveApprovalScope, applyMembershipScope } from "./timesheets-core-scope";
import {
  buildCursorPage,
  decodeCursor,
} from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { RateResolverService } from "./rate-resolver.service";
import { canActOnPeriod } from "./lib/approval-guard";
import {
  TIMESHEET_LIFECYCLE_EVENTS,
  emitPeriodLifecycleEvent,
  type PeriodLifecycleEvent,
} from "./events/timesheet-lifecycle.events";
import type { ApprovalsQuery } from "./dto/approvals.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";

/**
 * Everything a lifecycle event needs, returned by the UPDATE that performs the
 * transition. `event_seq` is only correct as read back from the statement that
 * incremented it — selecting it separately races another transition.
 *
 * Exported because the transitions live in more than one service
 * (`ApprovalsBulkService`, `PeriodsService`, `PeriodsSubmitService`), and what
 * an event carries should be written down once.
 *
 * The worker comes back as a membership: `timesheet_periods.user_id` was
 * dropped by the actor cutover (0715). The event contract still names the
 * worker by user id, which `membershipUserIds` reads back through it.
 */
export const LIFECYCLE_RETURNING = {
  eventSeq: timesheetPeriods.eventSeq,
  userMembershipId: timesheetPeriods.userMembershipId,
  periodStart: timesheetPeriods.periodStart,
  periodEnd: timesheetPeriods.periodEnd,
  status: timesheetPeriods.status,
  totalHours: timesheetPeriods.totalHours,
  billableHours: timesheetPeriods.billableHours,
  nonBillableHours: timesheetPeriods.nonBillableHours,
} as const;

export type LifecycleRow = {
  periodStart: string;
  periodEnd: string;
  status: PeriodLifecycleEvent["status"];
  totalHours: string;
  billableHours: string;
  nonBillableHours: string;
};

export function lifecyclePayload(
  orgId: string,
  periodId: number,
  row: LifecycleRow,
  ownerUserId: string,
  actorUserId: string,
  occurredAt: Date,
  reason: string | null,
): PeriodLifecycleEvent {
  return {
    organization_id: orgId,
    period_id: periodId,
    user_id: ownerUserId,
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

/**
 * The user id behind each membership, read inside `orgId` only.
 *
 * The lifecycle event contract and the notification pipeline both name people
 * by user id, while since the actor cutover a period knows its worker and its
 * approver only as memberships. Bounded by the ids asked for.
 */
export async function membershipUserIds(
  db: DbOrTx,
  orgId: string,
  membershipIds: readonly (number | null)[],
): Promise<Map<number, string>> {
  const ids = [...new Set(membershipIds.filter((id): id is number => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: organizationMembers.id, userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.id, ids)))
    .limit(ids.length);
  return new Map(rows.map((r) => [r.id, r.userId]));
}

/**
 * The worker's user id for a lifecycle event or notice, or null.
 *
 * The event schema requires `user_id` and notifications are addressed to
 * users, but since the actor cutover a period knows its worker only as a
 * membership, and that membership can stop resolving: removing a member sets
 * it to null. That is a reason to announce nothing about this one period, not
 * to fail the approval, rejection, submission or lock it belongs to, which
 * used to surface as a 500 and roll the transition back. Callers commit the
 * transition and skip only the event and the notice; the skip is logged here
 * so it can be reconciled. A skipped event leaves a gap in the period's
 * `event_seq`, which the outbox's UNIQUE index does not mind.
 */
export function periodOwnerUserIdOrWarn(
  owners: ReadonlyMap<number, string>,
  membershipId: number | null,
  context: { orgId: string; periodId: number; operation: string },
): string | null {
  const userId = membershipId === null ? undefined : owners.get(membershipId);
  if (userId) return userId;
  logger.warn(
    "timesheets: period owner membership does not resolve; lifecycle event and notice skipped",
    {
      orgId: context.orgId,
      periodId: context.periodId,
      ownerMembershipId: membershipId,
      operation: context.operation,
    },
  );
  return null;
}

export function isExpectedApprovalSkip(error: unknown): boolean {
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

  private async hasActiveDelegation(
    orgId: string,
    approverMembershipId: number,
    actorMembershipId: number,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: userDelegations.id })
      .from(userDelegations)
      .where(
        and(
          eq(userDelegations.orgId, orgId),
          eq(userDelegations.delegatorMembershipId, approverMembershipId),
          eq(userDelegations.delegateeMembershipId, actorMembershipId),
          eq(userDelegations.status, "ACTIVE"),
          lte(userDelegations.startsAt, new Date()),
          gt(userDelegations.endsAt, new Date()),
        ),
      )
      .limit(1);
    return !!row;
  }

  async assertCanActOnPeriod(
    u: CurrentUserContext,
    period: { userMembershipId: number | null; currentApproverMembershipId: number | null },
  ): Promise<void> {
    const membershipId = actingMembershipId(u.principal);
    const actor = {
      membershipId,
      isOrgOwner: !!u.isOrgOwner,
    };

    let delegateeOfApprover = false;
    if (
      period.currentApproverMembershipId &&
      period.currentApproverMembershipId !== membershipId &&
      period.userMembershipId !== membershipId &&
      membershipId !== null
    ) {
      delegateeOfApprover = await this.hasActiveDelegation(
        u.orgId,
        period.currentApproverMembershipId,
        membershipId,
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
    const pos = decodeCursor(query.cursor);
    const membershipId = actingMembershipId(u.principal);

    const conditions = [
      eq(timesheetPeriods.orgId, u.orgId),
      eq(timesheetPeriods.status, query.status),
      applyMembershipScope(scope, membershipId, timesheetPeriods.userMembershipId),
    ];

    if (query.userId && (scope === "all" || u.isOrgOwner)) {
      const [qMember] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, u.orgId),
            eq(organizationMembers.userId, query.userId),
          ),
        )
        .limit(1);
      if (qMember) conditions.push(eq(timesheetPeriods.userMembershipId, qMember.id));
    }
    if (query.startDate)
      conditions.push(gte(timesheetPeriods.periodStart, query.startDate));
    if (query.endDate)
      conditions.push(lte(timesheetPeriods.periodEnd, query.endDate));
    if (pos)
      conditions.push(
        keysetBeforeId(timesheetPeriods.submittedAt, timesheetPeriods.id, pos),
      );

    const approverMember = alias(organizationMembers, "approver_member");
    const ownerMember = alias(organizationMembers, "owner_member");

    const rows = await this.db
      .select({
        id: timesheetPeriods.id,
        orgId: timesheetPeriods.orgId,
        userMembershipId: timesheetPeriods.userMembershipId,
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
        currentApproverMembershipId: timesheetPeriods.currentApproverMembershipId,
        approvedBy: approverMember.userId,
        rejectionReason: timesheetPeriods.rejectionReason,
        createdAt: timesheetPeriods.createdAt,
        updatedAt: timesheetPeriods.updatedAt,
        userEmail: users.email,
        userName: users.name,
      })
      .from(timesheetPeriods)
      .leftJoin(ownerMember, and(
        eq(timesheetPeriods.orgId, ownerMember.orgId),
        eq(timesheetPeriods.userMembershipId, ownerMember.id),
      ))
      .leftJoin(users, eq(ownerMember.userId, users.id))
      .leftJoin(
        approverMember,
        and(
          eq(timesheetPeriods.orgId, approverMember.orgId),
          eq(timesheetPeriods.approvedByMembershipId, approverMember.id),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(timesheetPeriods.submittedAt), desc(timesheetPeriods.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (r) => ({
      sortValue: (r.submittedAt ?? r.createdAt).toISOString(),
      id: String(r.id),
    }));

    return {
      data: page.data.map((r) => ({
        ...r,
        user: {
          membershipId: r.userMembershipId,
          name: r.userName ?? r.userEmail,
          email: r.userEmail,
        },
      })),
      pagination: page.pagination,
    };
  }

  async approveSinglePeriod(u: CurrentUserContext, periodId: number) {
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

    const approverActor = await assertOrganizationActor(this.db, u.orgId, {
      kind: "user",
      userId: u.userId,
    }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError)
        throw organizationActorHttpError(e);
      throw e;
    });

    const settings = await this.getSettings(u.orgId);
    const lockAfterApproval = settings?.lockAfterApproval ?? true;
    const now = new Date();

    const owners = await membershipUserIds(this.db, u.orgId, [period.userMembershipId]);
    const ownerUserId = periodOwnerUserIdOrWarn(owners, period.userMembershipId, {
      orgId: u.orgId,
      periodId,
      operation: "approve",
    });

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
          approvedByMembershipId: approverActor.membershipId,
          approvedAt: now,
          lockedAt: lockAfterApproval ? now : null,
          lockedByMembershipId: lockAfterApproval
            ? approverActor.membershipId
            : null,
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
          userMembershipId: entry.userMembershipId,
          ticketId: entry.ticketId,
          date: entry.date,
        })),
      );

      type RateGroup = {
        billRate: string;
        costRate: string | null;
        currency: string;
        rateSource: (typeof resolvedRates)[number]["source"];
        ids: number[];
      };
      const rateGroups = new Map<string, RateGroup>();
      for (const [i, entry] of billableEntries.entries()) {
        const resolved = resolvedRates[i];
        if (!resolved || resolved.billRate === null) continue;
        const groupKey = `${resolved.billRate}:${resolved.costRate ?? ""}:${resolved.currency}:${resolved.source ?? ""}`;
        const group = rateGroups.get(groupKey) ?? {
          billRate: resolved.billRate.toString(),
          costRate:
            resolved.costRate !== null ? resolved.costRate.toString() : null,
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
        actorMembershipId: actingMembershipId(u.principal),
        entityType: "period",
        entityId: periodId.toString(),
        action: "period.approved",
        after: { status: "APPROVED" },
      });

      if (transition && ownerUserId) {
        const base = transition.eventSeq - emitCount + 1;
        const payload = lifecyclePayload(u.orgId, periodId, transition, ownerUserId, u.userId, now, null);

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
     * emailed about their own click. Nobody is told when the worker's
     * membership no longer resolves.
     */
    if (ownerUserId) {
      await this.notifications.emit({
        orgId: u.orgId,
        eventKey: "timesheets.period.approved",
        actorUserId: u.userId,
        targetUserIds: [ownerUserId],
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
  }

  async approvePeriod(u: CurrentUserContext, periodId: number) {
    await this.approveSinglePeriod(u, periodId);

    const approverMember = alias(organizationMembers, "approver_member");
    const ownerMember = alias(organizationMembers, "owner_member");

    const [updated] = await this.db
      .select({
        id: timesheetPeriods.id,
        orgId: timesheetPeriods.orgId,
        userMembershipId: timesheetPeriods.userMembershipId,
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
        currentApproverMembershipId: timesheetPeriods.currentApproverMembershipId,
        approvedBy: approverMember.userId,
        rejectionReason: timesheetPeriods.rejectionReason,
        createdAt: timesheetPeriods.createdAt,
        updatedAt: timesheetPeriods.updatedAt,
        userEmail: users.email,
        userName: users.name,
      })
      .from(timesheetPeriods)
      .leftJoin(ownerMember, and(
        eq(timesheetPeriods.orgId, ownerMember.orgId),
        eq(timesheetPeriods.userMembershipId, ownerMember.id),
      ))
      .leftJoin(users, eq(ownerMember.userId, users.id))
      .leftJoin(
        approverMember,
        and(
          eq(timesheetPeriods.orgId, approverMember.orgId),
          eq(timesheetPeriods.approvedByMembershipId, approverMember.id),
        ),
      )
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
   * TS-24. The worker hears that their week was sent back, through the same
   * pipeline as the approval notice above, after the caller's transaction.
   *
   * Rejection lives in `ApprovalsBulkService`. It reaches the dispatcher through
   * this service, which it already depends on for the approval guard, rather
   * than through a second injection of it.
   */
  async notifyPeriodRejected(
    u: CurrentUserContext,
    notice: {
      periodId: number;
      ownerUserId: string;
      title: string;
      message: string;
      variables: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.notifications.emit({
      orgId: u.orgId,
      eventKey: "timesheets.period.rejected",
      actorUserId: u.userId,
      targetUserIds: [notice.ownerUserId],
      entityType: "timesheet_period",
      entityId: String(notice.periodId),
      title: notice.title,
      message: notice.message,
      link: `/timesheets/my-time?period=${notice.periodId}`,
      variables: notice.variables,
    });
  }
}
