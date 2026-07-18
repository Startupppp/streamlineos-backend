import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  timesheetPeriods,
  timesheets,
  timesheetSettings,
  users,
  projects,
} from "../../db/schema";
import { AccessService } from "../access/access.service";
import { applyScope } from "../access/apply-scope";
import { resolveEntriesScope } from "./timesheets-core-scope";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { EntriesService } from "./entries.service";
import { weekRange } from "./lib/period.helpers";
import type { PeriodsQuery } from "./dto/periods.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

@Injectable()
export class PeriodsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly entries: EntriesService,
    private readonly audit: TimesheetsAuditService,
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
      applyScope(scope, u.userId, { ownerColumn: timesheetPeriods.userId }),
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

    return created!.id;
  }

  async getCurrent(u: CurrentUserContext) {
    const settings = await this.getSettings(u.orgId);
    const workWeekStart = settings?.workWeekStart ?? 1;
    const periodId = await this.findOrCreateCurrentPeriod(u.orgId, u.userId, workWeekStart);

    const row = await this.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");

    const periodEntries = await this.db.query.timesheets.findMany({
      where: and(
        eq(timesheets.timesheetPeriodId, periodId),
        eq(timesheets.orgId, u.orgId),
      ),
      orderBy: [desc(timesheets.date)],
    });

    return { period: this.mapPeriod(row), entries: periodEntries };
  }

  async getPeriod(u: CurrentUserContext, periodId: number) {
    const row = await this.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");

    const scope = await resolveEntriesScope(this.access, u);
    const canSeeOthers =
      u.isPlatformAdmin ||
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

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheetPeriods)
        .set({
          status: "SUBMITTED",
          submittedAt: new Date(),
          currentApproverId: approverId,
          updatedAt: new Date(),
        })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)));

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
    });

    const updated = await this.getPeriodWithUser(u.orgId, periodId);
    return this.mapPeriod(updated!);
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
      .where(and(eq(projects.id, topId), eq(projects.orgId, orgId)))
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
    return this.mapPeriod(updated!);
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
    return this.mapPeriod(updated!);
  }

  async lockPeriod(u: CurrentUserContext, periodId: number) {
    const row = await this.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheetPeriods)
        .set({ lockedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)));

      await tx
        .update(timesheets)
        .set({ lockedAt: new Date(), lockedBy: u.userId, updatedAt: new Date() })
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
    });

    const updated = await this.getPeriodWithUser(u.orgId, periodId);
    return this.mapPeriod(updated!);
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
    return this.mapPeriod(updated!);
  }
}
