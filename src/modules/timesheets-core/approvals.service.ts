import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  timesheetPeriods,
  timesheets,
  timesheetSettings,
  users,
} from "../../db/schema";
import { AccessService } from "../access/access.service";
import { applyScope } from "../access/apply-scope";
import { resolveApprovalScope } from "./timesheets-core-scope";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { RateResolverService } from "./rate-resolver.service";
import type {
  ApprovalsQuery,
  BulkApproveInput,
  BulkRejectInput,
  RejectPeriodInput,
} from "./dto/approvals.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

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

  async listApprovals(u: CurrentUserContext, query: ApprovalsQuery) {
    const scope = await resolveApprovalScope(this.access, u);
    const conditions = [
      eq(timesheetPeriods.orgId, u.orgId),
      eq(timesheetPeriods.status, query.status),
      applyScope(scope, u.userId, { ownerColumn: timesheetPeriods.userId }),
    ];

    if (query.userId && (scope === "all" || u.isPlatformAdmin || u.isOrgOwner)) {
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
      })
      .from(timesheetPeriods)
      .leftJoin(users, eq(timesheetPeriods.userId, users.id))
      .where(and(...conditions))
      .orderBy(desc(timesheetPeriods.submittedAt));

    return rows.map((r) => ({
      ...r,
      user: { id: r.userId, name: r.userName ?? r.userEmail, email: r.userEmail },
    }));
  }

  private async approveSinglePeriod(u: CurrentUserContext, periodId: number) {
    const [period] = await this.db
      .select()
      .from(timesheetPeriods)
      .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)))
      .limit(1);

    if (!period) throw new NotFoundException(`Period ${periodId} not found`);
    if (period.status !== "SUBMITTED") {
      throw new ConflictException(`Period ${periodId} is not in SUBMITTED state`);
    }

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
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)));

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
        })),
      );

      for (const [i, entry] of billableEntries.entries()) {
        const resolved = resolvedRates[i];
        if (resolved && resolved.billRate !== null) {
          await tx
            .update(timesheets)
            .set({
              billRate: resolved.billRate.toString(),
              currency: resolved.currency,
              rateSource: resolved.source,
              updatedAt: now,
            })
            .where(and(eq(timesheets.id, entry.id), eq(timesheets.orgId, u.orgId)));
        }
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
      .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)))
      .limit(1);

    return updated;
  }

  async rejectPeriod(u: CurrentUserContext, periodId: number, input: RejectPeriodInput) {
    const [period] = await this.db
      .select()
      .from(timesheetPeriods)
      .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)))
      .limit(1);

    if (!period) throw new NotFoundException("Period not found");
    if (period.status !== "SUBMITTED") throw new ConflictException("Only submitted periods can be rejected");

    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheetPeriods)
        .set({ status: "REJECTED", rejectedAt: now, rejectionReason: input.reason, updatedAt: now })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)));

      await tx
        .update(timesheets)
        .set({ status: "REJECTED", rejectionReason: input.reason, updatedAt: now })
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
      .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)))
      .limit(1);

    return updated;
  }

  async bulkApprove(u: CurrentUserContext, input: BulkApproveInput) {
    let approved = 0;
    for (const periodId of input.periodIds) {
      try {
        await this.approveSinglePeriod(u, periodId);
        approved++;
      } catch {
        // skip non-approvable periods
      }
    }
    return { approved };
  }

  async bulkReject(u: CurrentUserContext, input: BulkRejectInput) {
    const periods = await this.db
      .select({ id: timesheetPeriods.id, status: timesheetPeriods.status })
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.orgId, u.orgId),
          inArray(timesheetPeriods.id, input.periodIds),
          eq(timesheetPeriods.status, "SUBMITTED"),
        ),
      );

    if (periods.length === 0) return { rejected: 0 };

    const now = new Date();
    const ids = periods.map((p) => p.id);

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheetPeriods)
        .set({ status: "REJECTED", rejectedAt: now, rejectionReason: input.reason, updatedAt: now })
        .where(inArray(timesheetPeriods.id, ids));

      await tx
        .update(timesheets)
        .set({ status: "REJECTED", rejectionReason: input.reason, updatedAt: now })
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
