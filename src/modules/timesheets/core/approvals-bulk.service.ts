import { ConflictException, ForbiddenException, Inject, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { timesheetPeriods, timesheetSettings } from "../../../db/schema";
import { actingMembershipId } from "../../../common/auth/principal";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import {
  ApprovalsService,
  membershipUserIds,
  periodOwnerUserIdOrWarn,
} from "./approvals.service";
import { RateResolverService } from "./rate-resolver.service";
import { canActOnPeriod } from "./lib/approval-guard";
import { applyBulkApproval } from "./lib/approval-transition";
import { applyBulkRejection, applyRejection } from "./lib/rejection-transition";
import { readApprovedPeriod } from "./lib/approval-period-reads";
import type {
  BulkApproveInput,
  BulkRejectInput,
  RejectPeriodInput,
} from "./dto/approvals.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

/*
  The service decides who and whether: it reads the periods, runs the guard on
  each, resolves the owners, opens the transaction and sends the notices once it
  commits. What an approval or a rejection writes inside that transaction is in
  `lib/approval-transition.ts` and `lib/rejection-transition.ts`.
*/
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
      .select({
        status: timesheetPeriods.status,
        userMembershipId: timesheetPeriods.userMembershipId,
        currentApproverMembershipId: timesheetPeriods.currentApproverMembershipId,
        periodStart: timesheetPeriods.periodStart,
        periodEnd: timesheetPeriods.periodEnd,
      })
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

    const row = await readApprovedPeriod(this.db, u.orgId, periodId);
    if (!row) throw new InternalServerErrorException("Period not found after rejection");
    return {
      ...row,
      user: {
        membershipId: row.userMembershipId,
        name: row.userName ?? row.userEmail,
        email: row.userEmail,
      },
    };
  }

  /**
   * A mixed-tenant id list must fail the whole request. Both bulk actions used
   * to fold a foreign id into their ordinary skip path — the approve loop
   * swallowed the `NotFoundException` as a skip, and the reject query narrows to
   * the caller's org in the same predicate as the status filter — so the caller
   * was told the request succeeded. Tenant membership is checked first and on
   * its own, which leaves the per-period status and approver skips meaning what
   * they say. A miss is 404, never 403.
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
        periodStart: timesheetPeriods.periodStart,
        periodEnd: timesheetPeriods.periodEnd,
        totalHours: timesheetPeriods.totalHours,
      })
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.orgId, u.orgId),
          inArray(timesheetPeriods.id, requestedIds),
          eq(timesheetPeriods.status, "SUBMITTED"),
        ),
      );

    const membershipId = actingMembershipId(u.principal);
    const delegations =
      membershipId === null
        ? new Set<number>()
        : await this.approvals.activeDelegationsToActor(
            u.orgId,
            membershipId,
            candidates
              .map((p) => p.currentApproverMembershipId)
              .filter((id): id is number => id !== null),
          );

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
    /**
     * TS-15. A caller who may approve none of a SUBMITTED batch used to get
     * 200 `{ approved: 0, skipped: N }`, indistinguishable from "already
     * approved". The single-period route answers 403 for the same standing;
     * bulk must not launder that into success. Periods that are simply not
     * SUBMITTED stay a skip — those are not an authority miss.
     */
    if (approvable.length === 0) {
      if (candidates.length > 0) {
        throw new ForbiddenException("You are not allowed to approve any of the selected periods");
      }
      return { approved: 0, skipped };
    }

    const ids = approvable.map((p) => p.id);

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

    const owners = await membershipUserIds(
      this.db,
      u.orgId,
      approvable.map((p) => p.userMembershipId),
    );

    const now = new Date();
    const approvedIds = new Set(
      await this.db.transaction((tx) =>
        applyBulkApproval(
          tx,
          { rateResolver: this.rateResolver, audit: this.audit },
          u,
          ids,
          { approverActor, lockAfterApproval, owners, now },
        ),
      ),
    );

    /**
     * One notification per worker, after the batch commits — the same notice
     * `approveSinglePeriod` sends, for the same reason bulk rejection sends one
     * per period: one action for the approver is N pieces of news for N people.
     */
    for (const p of approvable) {
      if (!approvedIds.has(p.id)) continue;
      const ownerUserId =
        p.userMembershipId === null ? undefined : owners.get(p.userMembershipId);
      if (!ownerUserId) continue;
      await this.approvals.notifyPeriodApproved(u, {
        periodId: p.id,
        ownerUserId,
        title: `Timesheet approved: ${p.periodStart} to ${p.periodEnd}`,
        message: `Your timesheet for ${p.periodStart}–${p.periodEnd} (${p.totalHours}h) was approved.`,
        variables: {
          periodId: p.id,
          periodStart: p.periodStart,
          periodEnd: p.periodEnd,
          totalHours: p.totalHours,
        },
      });
    }

    /* A period decided by someone else between the check and the write counts as skipped, not overwritten. */
    return { approved: approvedIds.size, skipped: skipped + (ids.length - approvedIds.size) };
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
    const owners = await membershipUserIds(
      this.db,
      u.orgId,
      periods.map((p) => p.userMembershipId),
    );

    const rejectedIds = new Set(
      await this.db.transaction((tx) =>
        applyBulkRejection(tx, { audit: this.audit }, u, ids, {
          input,
          owners,
          now,
        }),
      ),
    );

    /**
     * One notification per worker, after the batch commits. A bulk rejection is
     * one action for the approver and N separate pieces of bad news for N
     * people, each of whom needs the reason and their own period link.
     */
    for (const p of periods) {
      if (!rejectedIds.has(p.id)) continue;
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

    return { rejected: rejectedIds.size };
  }
}
