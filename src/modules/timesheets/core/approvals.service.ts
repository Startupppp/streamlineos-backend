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
import { and, desc, gt, eq, gte, inArray, isNull, lte } from "drizzle-orm";
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

  /**
   * The delegators who have an active delegation to this actor, out of a bounded
   * set of approvers. A bulk endpoint resolves the whole page in one indexed
   * multi-key read instead of one probe per period.
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
      .select({ delegatorMembershipId: userDelegations.delegatorMembershipId })
      .from(userDelegations)
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

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheetPeriods)
        .set({
          status: "APPROVED",
          approvedAt: now,
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
    });
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
}
