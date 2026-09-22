import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  timesheets,
  timesheetExports,
  timesheetSettings,
  holidays,
  leaveRequests,
  users,
  organizationMembers,
} from "../../../db/schema";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import {
  buildPayrollRows,
  computeLeaveDays,
  resolveMapping,
  round2,
} from "./lib/payroll-calc";
import { PayrollExportsReadService } from "./payroll-exports-read.service";
import type { ScopedRead } from "../../access/scoped-read";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { TIMESHEET_EVENTS } from "./handoff/handoff.schemas";
import type {
  AckExportInput,
  ExportPayrollInput,
  ExportsListQuery,
  TimesheetExportDto,
} from "./dto/payroll.schemas";

function toExportDto(
  row: typeof timesheetExports.$inferSelect,
  creatorName: string | null,
): TimesheetExportDto {
  return {
    id: row.id,
    exportType: row.exportType,
    status: row.status,
    dateRangeStart: row.dateRangeStart,
    dateRangeEnd: row.dateRangeEnd,
    format: row.format,
    entryCount: row.entryCount,
    totalHours: parseFloat(row.totalHours),
    note: row.note,
    ackStatus: row.ackStatus,
    ackAt: row.ackAt ? row.ackAt.toISOString() : null,
    createdBy: null,
    createdByName: creatorName,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class PayrollExportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly reader: PayrollExportsReadService,
  ) {}

  listExports(read: ScopedRead, query: ExportsListQuery) {
    return this.reader.listExports(read, query);
  }

  getExportRows(read: ScopedRead, exportId: number) {
    return this.reader.getExportRows(read, exportId);
  }

  ackExport(orgId: string, userId: string, exportId: number, input: AckExportInput) {
    return this.reader.ackExport(orgId, userId, exportId, input);
  }

  async runExport(orgId: string, userId: string, input: ExportPayrollInput) {
    const [settings] = await this.db
      .select({
        overtimeDailyHours: timesheetSettings.overtimeDailyHours,
        overtimeWeeklyHours: timesheetSettings.overtimeWeeklyHours,
        includeNonBillable: timesheetSettings.includeNonBillable,
        payrollMapping: timesheetSettings.payrollMapping,
      })
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, orgId))
      .limit(1);

    const dailyThreshold = parseFloat(settings?.overtimeDailyHours ?? "8");
    const weeklyThreshold = parseFloat(settings?.overtimeWeeklyHours ?? "40");
    const payrollMapping = resolveMapping(settings?.payrollMapping);

    const { exportRow, rows } = await this.db.transaction(async (tx) => {
      let filterMembershipIds: number[] | null = null;
      if (input.userIds && input.userIds.length > 0) {
        const filterMembers = await tx
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, input.userIds)))
          .limit(input.userIds.length);
        filterMembershipIds = filterMembers.map((m) => m.id);
      }

      const conditions = [
        eq(timesheets.orgId, orgId),
        eq(timesheets.status, "APPROVED"),
        gte(timesheets.date, input.start),
        lte(timesheets.date, input.end),
      ];
      if (!input.includeExported) conditions.push(eq(timesheets.payrollStatus, "UNPROCESSED"));
      if (settings?.includeNonBillable === false) conditions.push(eq(timesheets.isBillable, true));
      if (filterMembershipIds !== null && filterMembershipIds.length > 0)
        conditions.push(inArray(timesheets.userMembershipId, filterMembershipIds));

      const eligible = await tx.select().from(timesheets).where(and(...conditions)).for("update");

      if (eligible.length === 0)
        throw new ConflictException("No eligible approved hours to export for this period");

      const uniqueMembIds = [...new Set(eligible.map((e) => e.userMembershipId).filter((id): id is number => id !== null))];
      const memberRows = uniqueMembIds.length > 0
        ? await tx.select({ id: organizationMembers.id, userId: organizationMembers.userId })
            .from(organizationMembers)
            .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.id, uniqueMembIds)))
            .limit(uniqueMembIds.length)
        : [];
      const membIdToUserId = new Map(memberRows.map((m) => [m.id, m.userId]));
      const userIdSet = new Set(memberRows.map((m) => m.userId));
      const userRows = await tx.select({ id: users.id, name: users.name, email: users.email })
        .from(users).where(inArray(users.id, [...userIdSet])).limit(userIdSet.size);
      const userMap = new Map(userRows.map((u) => [u.id, u]));

      const holidayRows = await tx.select({ date: holidays.date }).from(holidays)
        .where(and(eq(holidays.orgId, orgId), gte(holidays.date, input.start), lte(holidays.date, input.end)));
      const holidayDates = new Set(holidayRows.map((h) => h.date));

      const leaveRows = await tx.select({
        userId: leaveRequests.userId, startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate, isHalfDay: leaveRequests.isHalfDay,
      }).from(leaveRequests).where(and(
        eq(leaveRequests.orgId, orgId), eq(leaveRequests.status, "APPROVED"),
        lte(leaveRequests.startDate, input.end), gte(leaveRequests.endDate, input.start),
        inArray(leaveRequests.userId, [...userIdSet]),
      ));

      const leavesByUser = computeLeaveDays(leaveRows, input.start, input.end);
      const rows = buildPayrollRows(eligible, membIdToUserId, userMap, holidayDates, leavesByUser, input.start, input.end, dailyThreshold, weeklyThreshold);
      const totalHours = round2(rows.reduce((s, r) => s + r.totalPayableHours, 0));

      const [actorMember] = await tx.select({ id: organizationMembers.id }).from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId))).limit(1);

      const [exportRow] = await tx.insert(timesheetExports).values({
        orgId, exportType: "PAYROLL", status: "COMPLETED",
        dateRangeStart: input.start, dateRangeEnd: input.end, format: input.format,
        filters: { userIds: input.userIds, includeExported: input.includeExported, format: input.format, note: input.note, mapping: payrollMapping },
        snapshot: rows, entryCount: eligible.length, totalHours: totalHours.toString(),
        note: input.note ?? null, createdByMembershipId: actorMember?.id ?? null,
      }).returning();

      if (!exportRow) throw new InternalServerErrorException("Failed to create the payroll export record");

      await tx.update(timesheets).set({ payrollStatus: "EXPORTED", payrollExportId: exportRow.id, updatedAt: new Date() })
        .where(inArray(timesheets.id, eligible.map((e) => e.id)));

      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "timesheet_export",
        aggregateId: String(exportRow.id),
        aggregateVersion: 1,
        eventType: TIMESHEET_EVENTS.payrollExportReady,
        payload: {
          organization_id: orgId,
          export_id: exportRow.id,
          period_start: input.start,
          period_end: input.end,
          entry_count: exportRow.entryCount,
          worker_count: rows.length,
          total_hours: exportRow.totalHours,
          format: input.format,
          actor_user_id: userId,
        },
        occurredAt: new Date(),
      });

      return { exportRow, rows };
    });

    this.audit.log({
      action: "timesheets.payroll.exported", userId, orgId,
      metadata: { exportId: exportRow.id, start: input.start, end: input.end, format: input.format, entryCount: exportRow.entryCount, totalHours: exportRow.totalHours, userCount: rows.length },
    });

    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.payrollSummaryNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.payrollExportsNamespace(orgId)),
    ]);

    return { export: toExportDto(exportRow, null), rows };
  }
}
