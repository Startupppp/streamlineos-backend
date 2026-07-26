import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  timesheets,
  timesheetPeriods,
  timesheetSettings,
  projects,
  tickets,
} from "../../db/schema";
import { AccessService } from "../access/access.service";
import { applyScope } from "../access/apply-scope";
import { resolveEntriesScope } from "./timesheets-core-scope";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { weekRange, formatDateOnly } from "./lib/period.helpers";
import { roundHours } from "./lib/rounding";
import type { CreateEntryInput, UpdateEntryInput, VoidEntryInput, EntriesQuery } from "./dto/entries.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function buildEntryShape(r: {
  id: number;
  orgId: string;
  userId: string;
  ticketId: number | null;
  projectId: number | null;
  date: string;
  hours: string;
  description: string | null;
  isBillable: boolean;
  billingType: string;
  status: string;
  submittedAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  lockedAt: Date | null;
  voidedAt: Date | null;
  invoicingStatus: string;
  billRate: string | null;
  currency: string | null;
  rateSource: string | null;
  source: string;
  workLink: string | null;
  timesheetPeriodId: number | null;
  createdAt: Date;
  updatedAt: Date;
  directProjectId: number | null;
  directProjectName: string | null;
  ticketRowId: number | null;
  ticketTitle: string | null;
  ticketTicketNumber: number | null;
  ticketProjectId: number | null;
  ticketProjectName: string | null;
}) {
  return {
    id: r.id,
    orgId: r.orgId,
    userId: r.userId,
    ticketId: r.ticketId,
    projectId: r.projectId,
    date: r.date,
    hours: r.hours,
    description: r.description,
    isBillable: r.isBillable,
    billingType: r.billingType,
    status: r.status,
    submittedAt: r.submittedAt,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt,
    rejectionReason: r.rejectionReason,
    lockedAt: r.lockedAt,
    voidedAt: r.voidedAt,
    invoicingStatus: r.invoicingStatus,
    billRate: r.billRate,
    currency: r.currency,
    rateSource: r.rateSource,
    source: r.source,
    workLink: r.workLink,
    timesheetPeriodId: r.timesheetPeriodId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    project: r.directProjectId
      ? { id: r.directProjectId, name: r.directProjectName ?? "" }
      : null,
    ticket: r.ticketRowId
      ? {
          id: r.ticketRowId,
          title: r.ticketTitle ?? "",
          ticketNumber: r.ticketTicketNumber ?? 0,
          project: r.ticketProjectId
            ? { id: r.ticketProjectId, name: r.ticketProjectName ?? "" }
            : null,
        }
      : null,
  };
}

@Injectable()
export class EntriesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: TimesheetsAuditService,
  ) {}

  async listEntries(u: CurrentUserContext, query: EntriesQuery) {
    const scope = await resolveEntriesScope(this.access, u);
    const limit = Math.min(query.limit, 100);
    const offset = (query.page - 1) * limit;

    const conditions = [
      eq(timesheets.orgId, u.orgId),
      isNull(timesheets.voidedAt),
      applyScope(scope, u.userId, { ownerColumn: timesheets.userId }),
    ];

    if (query.userId && scope === "all") conditions.push(eq(timesheets.userId, query.userId));
    if (query.projectId) conditions.push(eq(timesheets.projectId, query.projectId));
    if (query.ticketId) conditions.push(eq(timesheets.ticketId, query.ticketId));
    if (query.status) conditions.push(eq(timesheets.status, query.status));
    if (query.startDate) conditions.push(gte(timesheets.date, query.startDate));
    if (query.endDate) conditions.push(lte(timesheets.date, query.endDate));
    if (query.billable === "true") conditions.push(eq(timesheets.isBillable, true));
    if (query.billable === "false") conditions.push(eq(timesheets.isBillable, false));

    const dp = alias(projects, "dp");
    const tp = alias(projects, "tp");

    const rows = await this.db
      .select({
        id: timesheets.id,
        orgId: timesheets.orgId,
        userId: timesheets.userId,
        ticketId: timesheets.ticketId,
        projectId: timesheets.projectId,
        date: timesheets.date,
        hours: timesheets.hours,
        description: timesheets.description,
        isBillable: timesheets.isBillable,
        billingType: timesheets.billingType,
        status: timesheets.status,
        submittedAt: timesheets.submittedAt,
        approvedBy: timesheets.approvedBy,
        approvedAt: timesheets.approvedAt,
        rejectionReason: timesheets.rejectionReason,
        lockedAt: timesheets.lockedAt,
        voidedAt: timesheets.voidedAt,
        invoicingStatus: timesheets.invoicingStatus,
        billRate: timesheets.billRate,
        currency: timesheets.currency,
        rateSource: timesheets.rateSource,
        source: timesheets.source,
        workLink: timesheets.workLink,
        timesheetPeriodId: timesheets.timesheetPeriodId,
        createdAt: timesheets.createdAt,
        updatedAt: timesheets.updatedAt,
        directProjectId: dp.id,
        directProjectName: dp.name,
        ticketRowId: tickets.id,
        ticketTitle: tickets.title,
        ticketTicketNumber: tickets.ticketNumber,
        ticketProjectId: tp.id,
        ticketProjectName: tp.name,
      })
      .from(timesheets)
      .leftJoin(dp, eq(timesheets.projectId, dp.id))
      .leftJoin(tickets, eq(timesheets.ticketId, tickets.id))
      .leftJoin(tp, eq(tickets.projectId, tp.id))
      .where(and(...conditions))
      .orderBy(desc(timesheets.date))
      .limit(limit)
      .offset(offset);

    return rows.map(buildEntryShape);
  }

  private async loadSettings(orgId: string) {
    const [settings] = await this.db
      .select()
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, orgId))
      .limit(1);
    return settings;
  }

  private async getOrCreatePeriod(
    orgId: string,
    userId: string,
    date: string,
    workWeekStart: number,
    dbOrTx: Pick<Db, "select" | "insert"> = this.db,
  ): Promise<number> {
    const range = weekRange(new Date(date + "T12:00:00"), workWeekStart);
    const matchesRange = and(
      eq(timesheetPeriods.orgId, orgId),
      eq(timesheetPeriods.userId, userId),
      eq(timesheetPeriods.periodStart, range.start),
      eq(timesheetPeriods.periodEnd, range.end),
    );

    const [existing] = await dbOrTx
      .select({ id: timesheetPeriods.id })
      .from(timesheetPeriods)
      .where(matchesRange)
      .limit(1);

    if (existing) return existing.id;

    const inserted = await dbOrTx
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
      .onConflictDoNothing()
      .returning({ id: timesheetPeriods.id });

    if (inserted[0]) return inserted[0].id;

    const [refetch] = await dbOrTx
      .select({ id: timesheetPeriods.id })
      .from(timesheetPeriods)
      .where(matchesRange)
      .limit(1);

    if (!refetch) {
      throw new ConflictException("Could not resolve the timesheet period for this date");
    }
    return refetch.id;
  }

  async recomputePeriodTotals(
    orgId: string,
    periodId: number,
    dbOrTx: Pick<Db, "select" | "update"> = this.db,
  ): Promise<void> {
    const [sums] = await dbOrTx
      .select({
        total: sql<string>`COALESCE(SUM(hours::numeric), 0)::text`,
        billable: sql<string>`COALESCE(SUM(CASE WHEN is_billable THEN hours::numeric ELSE 0 END), 0)::text`,
        nonBillable: sql<string>`COALESCE(SUM(CASE WHEN NOT is_billable THEN hours::numeric ELSE 0 END), 0)::text`,
      })
      .from(timesheets)
      .where(
        and(
          eq(timesheets.timesheetPeriodId, periodId),
          eq(timesheets.orgId, orgId),
          isNull(timesheets.voidedAt),
        ),
      );

    await dbOrTx
      .update(timesheetPeriods)
      .set({
        totalHours: sums?.total ?? "0",
        billableHours: sums?.billable ?? "0",
        nonBillableHours: sums?.nonBillable ?? "0",
        updatedAt: new Date(),
      })
      .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, orgId)));
  }

  private async syncTicketTimeSpent(
    dbOrTx: Pick<Db, "select" | "update">,
    orgId: string,
    ticketId: number,
  ): Promise<void> {
    const [ticketHours] = await dbOrTx
      .select({ total: sql<number>`COALESCE(SUM(hours::numeric), 0)` })
      .from(timesheets)
      .where(
        and(
          eq(timesheets.ticketId, ticketId),
          eq(timesheets.orgId, orgId),
          isNull(timesheets.voidedAt),
        ),
      );
    await dbOrTx
      .update(tickets)
      .set({ timeSpent: (ticketHours?.total ?? 0).toString() })
      .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)));
  }

  private async assertTicketInOrg(orgId: string, ticketId: number): Promise<void> {
    const [row] = await this.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException("Ticket not found");
  }

  private async assertProjectInOrg(orgId: string, projectId: number): Promise<void> {
    const [row] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException("Project not found");
  }

  async getEntryById(orgId: string, entryId: number) {
    const dp = alias(projects, "dp");
    const tp = alias(projects, "tp");

    const [row] = await this.db
      .select({
        id: timesheets.id,
        orgId: timesheets.orgId,
        userId: timesheets.userId,
        ticketId: timesheets.ticketId,
        projectId: timesheets.projectId,
        date: timesheets.date,
        hours: timesheets.hours,
        description: timesheets.description,
        isBillable: timesheets.isBillable,
        billingType: timesheets.billingType,
        status: timesheets.status,
        submittedAt: timesheets.submittedAt,
        approvedBy: timesheets.approvedBy,
        approvedAt: timesheets.approvedAt,
        rejectionReason: timesheets.rejectionReason,
        lockedAt: timesheets.lockedAt,
        voidedAt: timesheets.voidedAt,
        invoicingStatus: timesheets.invoicingStatus,
        billRate: timesheets.billRate,
        currency: timesheets.currency,
        rateSource: timesheets.rateSource,
        source: timesheets.source,
        workLink: timesheets.workLink,
        timesheetPeriodId: timesheets.timesheetPeriodId,
        createdAt: timesheets.createdAt,
        updatedAt: timesheets.updatedAt,
        directProjectId: dp.id,
        directProjectName: dp.name,
        ticketRowId: tickets.id,
        ticketTitle: tickets.title,
        ticketTicketNumber: tickets.ticketNumber,
        ticketProjectId: tp.id,
        ticketProjectName: tp.name,
      })
      .from(timesheets)
      .leftJoin(dp, eq(timesheets.projectId, dp.id))
      .leftJoin(tickets, eq(timesheets.ticketId, tickets.id))
      .leftJoin(tp, eq(tickets.projectId, tp.id))
      .where(and(eq(timesheets.id, entryId), eq(timesheets.orgId, orgId)));

    if (!row) throw new NotFoundException("Time entry not found");
    return buildEntryShape(row);
  }

  async createEntry(u: CurrentUserContext, input: CreateEntryInput) {
    const settings = await this.loadSettings(u.orgId);
    const workWeekStart = settings?.workWeekStart ?? 1;
    const maxHoursPerDay = parseFloat(settings?.maxHoursPerDay ?? "24");
    const allowBackdated = settings?.allowBackdatedEntries ?? true;
    const backdateLimitDays = settings?.backdateLimitDays ?? null;
    const hours = roundHours(input.hours, settings?.roundingRule);

    const today = formatDateOnly(new Date());
    if (!allowBackdated && input.date < today) {
      throw new BadRequestException("Backdated entries are not allowed");
    }
    if (backdateLimitDays !== null && input.date < today) {
      const diffDays = Math.floor(
        (new Date(today).getTime() - new Date(input.date + "T12:00:00").getTime()) / 86_400_000,
      );
      if (diffDays > backdateLimitDays) {
        throw new BadRequestException(
          `Cannot log time more than ${backdateLimitDays} days in the past`,
        );
      }
    }

    const requiredFields = (settings?.requiredFields as string[] | null) ?? [];
    if (requiredFields.includes("project") && !input.projectId && !input.ticketId) {
      throw new BadRequestException("Field 'project' is required");
    }
    if (requiredFields.includes("description") && !input.description) {
      throw new BadRequestException("Field 'description' is required");
    }
    if (requiredFields.includes("ticket") && !input.ticketId) {
      throw new BadRequestException("Field 'ticket' is required");
    }

    const [dailyHours] = await this.db
      .select({ total: sql<string>`COALESCE(SUM(hours::numeric), 0)::text` })
      .from(timesheets)
      .where(
        and(
          eq(timesheets.orgId, u.orgId),
          eq(timesheets.userId, u.userId),
          eq(timesheets.date, input.date),
          isNull(timesheets.voidedAt),
        ),
      );

    const currentTotal = parseFloat(dailyHours?.total ?? "0");
    if (currentTotal + hours > maxHoursPerDay) {
      throw new BadRequestException(
        `Logging ${hours}h would exceed the daily limit of ${maxHoursPerDay}h`,
      );
    }

    const billingType = input.billingType ?? (input.isBillable ? "BILLABLE" : "NON_BILLABLE");
    const isBillable = input.isBillable ?? billingType === "BILLABLE";

    if (input.ticketId != null || input.projectId != null) {
      await Promise.all([
        input.ticketId != null
          ? this.assertTicketInOrg(u.orgId, input.ticketId)
          : Promise.resolve(),
        input.projectId != null
          ? this.assertProjectInOrg(u.orgId, input.projectId)
          : Promise.resolve(),
      ]);
    }

    const entry = await this.db.transaction(async (tx) => {
      const periodId = await this.getOrCreatePeriod(
        u.orgId,
        u.userId,
        input.date,
        workWeekStart,
        tx,
      );

      const [inserted] = await tx
        .insert(timesheets)
        .values({
          orgId: u.orgId,
          userId: u.userId,
          ticketId: input.ticketId ?? null,
          projectId: input.projectId ?? null,
          date: input.date,
          hours: hours.toString(),
          description: input.description ?? null,
          isBillable,
          billingType,
          workLink: input.workLink ?? null,
          source: input.source ?? "MANUAL",
          timesheetPeriodId: periodId,
          status: "PENDING",
          invoicingStatus: "UNINVOICED",
          payrollStatus: "UNPROCESSED",
        })
        .returning();

      if (!inserted) throw new ConflictException("Could not create the time entry");

      if (input.ticketId) {
        await this.syncTicketTimeSpent(tx, u.orgId, input.ticketId);
      }

      await this.recomputePeriodTotals(u.orgId, periodId, tx);

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "entry",
        entityId: inserted.id.toString(),
        action: "entry.created",
        after: {
          hours,
          ...(hours !== input.hours ? { rawHours: input.hours } : {}),
          date: input.date,
          projectId: input.projectId,
          ticketId: input.ticketId,
        },
      });

      return inserted;
    });

    return this.getEntryById(u.orgId, entry.id);
  }

  async updateEntry(u: CurrentUserContext, entryId: number, input: UpdateEntryInput) {
    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, u.orgId)),
    });
    if (!entry) throw new NotFoundException("Time entry not found");

    if (entry.voidedAt) throw new ConflictException("Voided entries cannot be edited");
    if (entry.lockedAt) throw new ConflictException("Locked entries cannot be edited");
    if (entry.payrollStatus === "EXPORTED") throw new ConflictException("Exported entries cannot be edited");
    if (entry.invoicingStatus !== "UNINVOICED") throw new ConflictException("Invoiced entries cannot be edited");
    if (!["PENDING", "REJECTED"].includes(entry.status)) throw new ConflictException("Only pending or rejected entries can be edited");
    if (entry.submittedAt) throw new ConflictException("Submitted entries cannot be edited");

    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const canManage = perms.has("timesheets:approvals:manage") || u.isOrgOwner || u.isPlatformAdmin;
    if (!canManage && entry.userId !== u.userId) {
      throw new ForbiddenException("You can only edit your own time entries");
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (input.hours !== undefined) {
      const settings = await this.loadSettings(u.orgId);
      updateData.hours = roundHours(input.hours, settings?.roundingRule).toString();
    }
    if (input.description !== undefined) updateData.description = input.description;
    if (input.isBillable !== undefined) updateData.isBillable = input.isBillable;
    if (input.billingType !== undefined) {
      updateData.billingType = input.billingType;
      if (input.isBillable === undefined) {
        updateData.isBillable = input.billingType === "BILLABLE";
      }
    }
    if (input.projectId !== undefined) updateData.projectId = input.projectId;
    if (input.workLink !== undefined) updateData.workLink = input.workLink;

    if (input.projectId != null) {
      await this.assertProjectInOrg(u.orgId, input.projectId);
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheets)
        .set(updateData)
        .where(and(eq(timesheets.id, entryId), eq(timesheets.orgId, u.orgId)));

      if (input.hours !== undefined && entry.ticketId) {
        await this.syncTicketTimeSpent(tx, u.orgId, entry.ticketId);
      }

      if (entry.timesheetPeriodId) {
        await this.recomputePeriodTotals(u.orgId, entry.timesheetPeriodId, tx);
      }

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "entry",
        entityId: entryId.toString(),
        action: "entry.updated",
        before: { hours: entry.hours, description: entry.description },
        after: updateData,
      });
    });

    return this.getEntryById(u.orgId, entryId);
  }

  async voidEntry(u: CurrentUserContext, entryId: number, input: VoidEntryInput) {
    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, u.orgId)),
    });
    if (!entry) throw new NotFoundException("Time entry not found");

    if (entry.payrollStatus === "EXPORTED") {
      throw new ConflictException("Exported entries cannot be voided");
    }
    if (["INVOICE_DRAFTED", "INVOICED"].includes(entry.invoicingStatus)) {
      throw new ConflictException("Invoiced entries cannot be voided");
    }

    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const canManage = perms.has("timesheets:approvals:manage") || u.isOrgOwner || u.isPlatformAdmin;
    if (!canManage && entry.userId !== u.userId) {
      throw new ForbiddenException("You can only void your own time entries");
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheets)
        .set({ voidedAt: new Date(), voidReason: input.reason, updatedAt: new Date() })
        .where(and(eq(timesheets.id, entryId), eq(timesheets.orgId, u.orgId)));

      if (entry.ticketId) {
        await this.syncTicketTimeSpent(tx, u.orgId, entry.ticketId);
      }

      if (entry.timesheetPeriodId) {
        await this.recomputePeriodTotals(u.orgId, entry.timesheetPeriodId, tx);
      }

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "entry",
        entityId: entryId.toString(),
        action: "entry.voided",
        reason: input.reason,
        before: { status: entry.status, hours: entry.hours },
      });
    });

    return { success: true };
  }
}
