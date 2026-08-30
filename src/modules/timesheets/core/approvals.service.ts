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
import { applyScope } from "../../access/apply-scope";
import { resolveApprovalScope } from "./timesheets-core-scope";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { RateResolverService } from "./rate-resolver.service";
import { canActOnPeriod } from "./lib/approval-guard";
import type { ApprovalsQuery } from "./dto/approvals.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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

  async assertCanActOnPeriod(
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

    const approverActor = await assertOrganizationActor(this.db, u.orgId, { kind: "user", userId: u.userId }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    });

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
          approvedByMembershipId: approverActor.membershipId,
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
          approvedByMembershipId: approverActor.membershipId,
          approvedAt: now,
          lockedAt: lockAfterApproval ? now : null,
          lockedBy: lockAfterApproval ? u.userId : null,
          lockedByMembershipId: lockAfterApproval ? approverActor.membershipId : null,
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

}
