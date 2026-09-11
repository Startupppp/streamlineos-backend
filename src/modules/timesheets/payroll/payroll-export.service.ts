import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  timesheets,
  timesheetExports,
  timesheetSettings,
  holidays,
  leaveRequests,
  users,
} from "../../../db/schema";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import {
  computeLeaveDays,
  computeOvertime,
  isWeekend,
  resolveMapping,
  round2,
} from "./lib/payroll-calc";
import { payrollSnapshotSchema } from "./dto/payroll.schemas";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { TIMESHEET_EVENTS } from "./handoff/handoff.schemas";
import type {
  AckExportInput,
  ExportPayrollInput,
  ExportsListQuery,
  PayrollExportRow,
  TimesheetExportDto,
} from "./dto/payroll.schemas";

const exportFiltersSchema = z.object({ mapping: z.unknown().optional() }).passthrough();

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
    createdBy: row.createdBy,
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
  ) {}

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
      const conditions = [
        eq(timesheets.orgId, orgId),
        eq(timesheets.status, "APPROVED"),
        gte(timesheets.date, input.start),
        lte(timesheets.date, input.end),
      ];
      if (!input.includeExported) conditions.push(eq(timesheets.payrollStatus, "UNPROCESSED"));
      if (settings?.includeNonBillable === false) conditions.push(eq(timesheets.isBillable, true));
      if (input.userIds && input.userIds.length > 0) conditions.push(inArray(timesheets.userId, input.userIds));

      const eligible = await tx
        .select()
        .from(timesheets)
        .where(and(...conditions))
        .for("update");

      if (eligible.length === 0) {
        throw new ConflictException("No eligible approved hours to export for this period");
      }

      const userIdSet = new Set(eligible.map((e) => e.userId));
      const userRows = await tx
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, [...userIdSet]));
      const userMap = new Map(userRows.map((u) => [u.id, u]));

      const holidayRows = await tx
        .select({ date: holidays.date })
        .from(holidays)
        .where(and(eq(holidays.orgId, orgId), gte(holidays.date, input.start), lte(holidays.date, input.end)));
      const holidayDates = new Set(holidayRows.map((h) => h.date));

      const leaveRows = await tx
        .select({ userId: leaveRequests.userId, startDate: leaveRequests.startDate, endDate: leaveRequests.endDate, isHalfDay: leaveRequests.isHalfDay })
        .from(leaveRequests)
        .where(and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.status, "APPROVED"), lte(leaveRequests.startDate, input.end), gte(leaveRequests.endDate, input.start), inArray(leaveRequests.userId, [...userIdSet])));

      const leavesByUser = computeLeaveDays(leaveRows, input.start, input.end);
      const byUser = new Map<string, typeof eligible[number][]>();
      for (const e of eligible) {
        const arr = byUser.get(e.userId) ?? [];
        arr.push(e);
        byUser.set(e.userId, arr);
      }

      const rows: PayrollExportRow[] = [];
      for (const [uid, userEntries] of byUser) {
        const user = userMap.get(uid);
        const otEntries = userEntries.map((e) => ({ date: e.date, hours: parseFloat(e.hours) }));
        const overtimeHours = computeOvertime(otEntries, dailyThreshold, weeklyThreshold);
        let totalPayableHours = 0, billableHours = 0, nonBillableHours = 0;
        let holidayHours = 0, weekendHours = 0;
        for (const e of userEntries) {
          const h = parseFloat(e.hours);
          totalPayableHours += h;
          if (e.isBillable) billableHours += h; else nonBillableHours += h;
          if (holidayDates.has(e.date)) holidayHours += h;
          if (isWeekend(e.date)) weekendHours += h;
        }
        rows.push({
          userId: uid,
          employeeName: user?.name ?? user?.email ?? "Former user",
          employeeEmail: user?.email ?? "",
          periodStart: input.start,
          periodEnd: input.end,
          regularHours: round2(totalPayableHours - overtimeHours),
          overtimeHours: round2(overtimeHours),
          holidayHours: round2(holidayHours),
          weekendHours: round2(weekendHours),
          breakHours: 0,
          leaveDays: round2(leavesByUser.get(uid) ?? 0),
          billableHours: round2(billableHours),
          nonBillableHours: round2(nonBillableHours),
          totalPayableHours: round2(totalPayableHours),
          entryCount: userEntries.length,
        });
      }

      rows.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
      const totalHours = round2(rows.reduce((s, r) => s + r.totalPayableHours, 0));

      const [exportRow] = await tx
        .insert(timesheetExports)
        .values({
          orgId,
          exportType: "PAYROLL",
          status: "COMPLETED",
          dateRangeStart: input.start,
          dateRangeEnd: input.end,
          format: input.format,
          filters: { userIds: input.userIds, includeExported: input.includeExported, format: input.format, note: input.note, mapping: payrollMapping },
          snapshot: rows,
          entryCount: eligible.length,
          totalHours: totalHours.toString(),
          note: input.note ?? null,
          createdBy: userId,
        })
        .returning();

      if (!exportRow) {
        throw new InternalServerErrorException("Failed to create the payroll export record");
      }

      await tx
        .update(timesheets)
        .set({ payrollStatus: "EXPORTED", payrollExportId: exportRow.id, updatedAt: new Date() })
        .where(inArray(timesheets.id, eligible.map((e) => e.id)));

      /**
       * Emitted inside this transaction, not after it, so an export can never
       * exist without its handoff event and an event can never point at an
       * export that rolled back. The rows themselves stay out of the payload
       * — they are on `exportRow.snapshot` already, and duplicating every
       * worker's name and email into a durable replayable log is not a
       * reasonable price for saving the consumer one read.
       */
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "timesheet_export",
        aggregateId: String(exportRow.id),
        /**
         * 1, and only ever 1. `(org, aggregate_type, aggregate_id,
         * aggregate_version)` is unique, and an export row is created once and
         * never revised — so this aggregate has exactly one version. The
         * `Date.now()` used by aggregates that do change would buy nothing
         * here and would make a replay look like a second version.
         */
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
      action: "timesheets.payroll.exported",
      userId,
      orgId,
      metadata: {
        exportId: exportRow.id,
        start: input.start,
        end: input.end,
        format: input.format,
        entryCount: exportRow.entryCount,
        totalHours: exportRow.totalHours,
        userCount: rows.length,
      },
    });

    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.payrollSummaryNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.payrollExportsNamespace(orgId)),
    ]);

    return {
      export: toExportDto(exportRow, null),
      rows,
    };
  }

  async listExports(orgId: string, query: ExportsListQuery) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.payrollExportsNamespace(orgId),
      `${query.page}:${query.pageSize}`,
      async () => {
        const offset = (query.page - 1) * query.pageSize;
        const rows = await this.db
          .select({
            export: timesheetExports,
            creatorName: users.name,
            windowTotal: sql<string>`count(*) OVER ()`,
          })
          .from(timesheetExports)
          .leftJoin(users, eq(timesheetExports.createdBy, users.id))
          .where(eq(timesheetExports.orgId, orgId))
          .orderBy(desc(timesheetExports.createdAt))
          .limit(query.pageSize)
          .offset(offset);

        const first = rows[0];
        let total: number;
        if (first) {
          total = Number(first.windowTotal);
        } else if (offset === 0) {
          total = 0;
        } else {
          const fallback = await this.db
            .select({ n: sql<string>`count(*)` })
            .from(timesheetExports)
            .where(eq(timesheetExports.orgId, orgId));
          total = Number(fallback[0]?.n ?? 0);
        }

        return {
          items: rows.map(({ windowTotal: _, export: exp, creatorName }) =>
            toExportDto(exp, creatorName ?? null),
          ),
          total,
          page: query.page,
          pageSize: query.pageSize,
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async getExportRows(orgId: string, exportId: number) {
    const [result] = await this.db
      .select({ export: timesheetExports, creatorName: users.name })
      .from(timesheetExports)
      .leftJoin(users, eq(timesheetExports.createdBy, users.id))
      .where(and(eq(timesheetExports.id, exportId), eq(timesheetExports.orgId, orgId)))
      .limit(1);

    if (!result) throw new NotFoundException("Export not found");

    const parsedSnapshot = payrollSnapshotSchema.safeParse(result.export.snapshot);
    const rows: PayrollExportRow[] = parsedSnapshot.success ? parsedSnapshot.data : [];

    const parsedFilters = exportFiltersSchema.safeParse(result.export.filters ?? {});
    const mappingRaw = parsedFilters.success ? parsedFilters.data.mapping : undefined;
    const mapping = mappingRaw === undefined || mappingRaw === null ? null : resolveMapping(mappingRaw);

    return {
      export: toExportDto(result.export, result.creatorName ?? null),
      rows,
      mapping,
    };
  }

  async ackExport(orgId: string, userId: string, exportId: number, input: AckExportInput) {
    const [existing] = await this.db
      .select({ id: timesheetExports.id, creatorName: users.name })
      .from(timesheetExports)
      .leftJoin(users, eq(timesheetExports.createdBy, users.id))
      .where(and(eq(timesheetExports.id, exportId), eq(timesheetExports.orgId, orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Export not found");

    const ackAt = new Date();
    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(timesheetExports)
        .set({
          ackStatus: input.status,
          ackNote: input.note ?? null,
          ackAt,
          ackBy: userId,
        })
        .where(and(eq(timesheetExports.id, exportId), eq(timesheetExports.orgId, orgId)))
        .returning();

      if (!row) return null;

      /**
       * In the same transaction as the status it reports, so an
       * acknowledgement cannot be recorded without its event or announced
       * without being recorded.
       */
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "timesheet_export",
        aggregateId: String(exportId),
        /**
         * Not 1. `(org, aggregate_type, aggregate_id, aggregate_version)` is
         * unique and version 1 is the export's own creation event, so a
         * constant here would collide on the first ack. An export can also be
         * acknowledged repeatedly as its status moves — RECEIVED then
         * ACCEPTED, or later REJECTED — so the version has to grow with each
         * one rather than identify the export.
         */
        aggregateVersion: ackAt.getTime(),
        eventType: TIMESHEET_EVENTS.payrollExportAcked,
        payload: {
          organization_id: orgId,
          export_id: exportId,
          status: input.status,
          note: input.note ?? null,
          acked_at: ackAt.toISOString(),
          actor_user_id: userId,
        },
        occurredAt: ackAt,
      });

      return row;
    });

    if (!updated) {
      throw new InternalServerErrorException("Failed to acknowledge the export");
    }

    this.audit.log({
      action: "timesheets.payroll.export_acknowledged",
      userId,
      orgId,
      metadata: {
        exportId,
        status: input.status,
        note: input.note ?? null,
      },
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.payrollExportsNamespace(orgId));

    return { export: toExportDto(updated, existing.creatorName ?? null) };
  }
}
