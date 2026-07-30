import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  count,
  desc,
  gt,
  eq,
  gte,
  inArray,
  isNull,
  lte,
} from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { logger } from "../../common/logger/logger.service";
import { type Db } from "../../db/drizzle.module";
import {
  timesheetPeriods,
  timesheets,
  timesheetSettings,
  userDelegations,
  users,
} from "../../db/schema";
import { AccessService } from "../access/access.service";
import { applyScope } from "../access/apply-scope";
import { resolveApprovalScope } from "./timesheets-core-scope";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { RateResolverService } from "./rate-resolver.service";
import { canActOnPeriod } from "./lib/approval-guard";
import type {
  ApprovalsQuery,
  BulkApproveInput,
  BulkRejectInput,
  RejectPeriodInput,
} from "./dto/approvals.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

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
    const [row] = await this.db
      .select({ id: userDelegations.id })
      .from(userDelegations)
      .where(
        and(
          eq(userDelegations.orgId, orgId),
          eq(userDelegations.delegatorId, approverId),
          eq(userDelegations.delegateeId, actorUserId),
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
      applyScope(scope, u.userId, { ownerColumn: timesheetPeriods.userId }),
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

    const [rows, totalResult] = await Promise.all([
      this.db
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
        .orderBy(desc(timesheetPeriods.submittedAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(timesheetPeriods)
        .where(and(...conditions)),
    ]);

    const data = rows.map((r) => ({
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
        total: totalResult[0]?.total ?? 0,
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

    const settings = await this.getSettings(u.orgId);
    const lockAfterApproval = settings?.lockAfterApproval ?? true;
    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheetPeriods)
        .set({
          status: "APPROVED",
          approvedAt: now,
          approvedBy: u.userId,
          lockedAt: lockAfterApproval ? now : null,
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
          status: "APPROVED",
          approvedBy: u.userId,
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

      type RateGroup = { billRate: string; currency: string; rateSource: typeof resolvedRates[number]["source"]; ids: number[] };
      const rateGroups = new Map<string, RateGroup>();
      for (const [i, entry] of billableEntries.entries()) {
        const resolved = resolvedRates[i];
        if (!resolved || resolved.billRate === null) continue;
        const groupKey = `${resolved.billRate}:${resolved.currency}:${resolved.source ?? ""}`;
        const group = rateGroups.get(groupKey) ?? {
          billRate: resolved.billRate.toString(),
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
        actorUserId: u.userId,
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
      } catch {
        // skip periods this actor is not allowed to act on
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
    });

    return { rejected: ids.length };
  }
}
