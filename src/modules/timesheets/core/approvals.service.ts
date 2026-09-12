import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import { and, gt, eq, gte, inArray, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  organizationMembers,
  timesheetPeriods,
  timesheetSettings,
  userDelegationPermissions,
  userDelegations,
} from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { actingMembershipId } from "../../../common/auth/principal";
import { resolveApprovalScope, membershipScope, TS_APPROVALS_MANAGE_PERMISSION } from "./timesheets-core-scope";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { RateResolverService } from "./rate-resolver.service";
import { canActOnPeriod } from "./lib/approval-guard";
import { membershipUserIds, periodOwnerUserIdOrWarn } from "./lib/approval-lifecycle";
import { listApprovalRows, readApprovedPeriod } from "./lib/approval-period-reads";
import { applyApproval } from "./lib/approval-transition";
import type { ApprovalsQuery } from "./dto/approvals.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

// The lifecycle-event and period-owner helpers live in `lib/approval-lifecycle.ts`;
// ApprovalsBulkService, PeriodsService and PeriodsSubmitService import them from here.
export {
  LIFECYCLE_RETURNING,
  lifecyclePayload,
  membershipUserIds,
  periodOwnerUserIdOrWarn,
} from "./lib/approval-lifecycle";
export type { LifecycleRow } from "./lib/approval-lifecycle";

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

  /**
   * The delegators who have an active delegation to this actor that carries
   * the approval authority, out of a bounded set of approvers. A bulk endpoint
   * resolves the whole page in one indexed multi-key read instead of one probe
   * per period.
   *
   * A delegation stores one child row per permission it hands over (§5), so
   * "acting for the approver" means holding a delegation that names
   * `timesheets:approvals:manage`. Reading only the header, as this did, let a
   * delegation of any key at all — a knowledge-base read, say — confer
   * standing over the delegator's approval queue.
   */
  async activeDelegationsToActor(
    orgId: string,
    actorMembershipId: number,
    approverMembershipIds: readonly number[],
  ): Promise<ReadonlySet<number>> {
    const wanted = [...new Set(approverMembershipIds)];
    if (wanted.length === 0) return new Set<number>();
    const now = new Date();
    const rows = await this.db
      .selectDistinct({ delegatorMembershipId: userDelegations.delegatorMembershipId })
      .from(userDelegations)
      .innerJoin(
        userDelegationPermissions,
        and(
          eq(userDelegationPermissions.orgId, userDelegations.orgId),
          eq(userDelegationPermissions.delegationId, userDelegations.id),
          eq(userDelegationPermissions.permissionKey, TS_APPROVALS_MANAGE_PERMISSION),
        ),
      )
      .where(
        and(
          eq(userDelegations.orgId, orgId),
          inArray(userDelegations.delegatorMembershipId, wanted),
          eq(userDelegations.delegateeMembershipId, actorMembershipId),
          eq(userDelegations.status, "ACTIVE"),
          lte(userDelegations.startsAt, now),
          gt(userDelegations.endsAt, now),
        ),
      )
      .limit(wanted.length);
    return new Set(rows.map((row) => row.delegatorMembershipId));
  }

  async assertCanActOnPeriod(
    u: CurrentUserContext,
    period: { userMembershipId: number | null; currentApproverMembershipId: number | null },
    resolvedDelegations?: ReadonlySet<number>,
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
      delegateeOfApprover =
        resolvedDelegations !== undefined
          ? resolvedDelegations.has(period.currentApproverMembershipId)
          : (
              await this.activeDelegationsToActor(u.orgId, membershipId, [
                period.currentApproverMembershipId,
              ])
            ).has(period.currentApproverMembershipId);
    }

    const decision = canActOnPeriod(actor, period, { delegateeOfApprover });
    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason);
    }
  }

  async listApprovals(u: CurrentUserContext, query: ApprovalsQuery) {
    const read = await resolveApprovalScope(this.access, u);
    const limit = Math.min(query.limit, 100);
    const pos = decodeCursor(query.cursor);
    const membershipId = actingMembershipId(u.principal);

    let requestedMembershipId: number | undefined;
    if (query.userId && (read.discriminator === "all" || u.isOrgOwner)) {
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
      if (qMember) requestedMembershipId = qMember.id;
    }

    return read.read(
      {
        tenant: timesheetPeriods.orgId,
        scope: membershipScope(membershipId, timesheetPeriods.userMembershipId),
        and: [
          eq(timesheetPeriods.status, query.status),
          requestedMembershipId !== undefined ? eq(timesheetPeriods.userMembershipId, requestedMembershipId) : undefined,
          query.startDate ? gte(timesheetPeriods.periodStart, query.startDate) : undefined,
          query.endDate ? lte(timesheetPeriods.periodEnd, query.endDate) : undefined,
          pos ? keysetBeforeId(timesheetPeriods.submittedAt, timesheetPeriods.id, pos) : undefined,
        ],
      },
      async ({ sql: where }) => {
        const rows = await listApprovalRows(this.db, [where], limit);

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
      },
      () => ({ data: [], pagination: { limit, hasMore: false, nextCursor: null } }),
    );
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

    await this.db.transaction((tx) =>
      applyApproval(
        tx,
        { rateResolver: this.rateResolver, audit: this.audit },
        u,
        periodId,
        { approverActor, lockAfterApproval, emitCount, ownerUserId, now },
      ),
    );

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
      await this.notifyPeriodApproved(u, {
        periodId,
        ownerUserId,
        title: `Timesheet approved: ${period.periodStart} to ${period.periodEnd}`,
        message: `Your timesheet for ${period.periodStart}–${period.periodEnd} (${period.totalHours}h) was approved.`,
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
    return readApprovedPeriod(this.db, u.orgId, periodId);
  }

  /**
   * TS-24. The worker hears that their week was signed off. Sent after the
   * approving transaction commits, by the single approval above and once per
   * worker by `ApprovalsBulkService.bulkApprove`.
   */
  async notifyPeriodApproved(
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
      eventKey: "timesheets.period.approved",
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
