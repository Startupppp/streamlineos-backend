import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { attendance } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { HrAutomationEngineService } from "../hr/automations/hr-automation-engine.service";
import {
  AttendancePolicyService,
  type AttendancePolicyRules,
  type OvertimePolicyRules,
} from "../hr/time/attendance-policy.service";
import { bulkUpdateFromValues, type BulkUpdateRow } from "../../common/db/bulk-update";
import { forEachOrg } from "../../common/tenant";

const DEFAULT_AUTO_CHECKOUT_TIME = "19:00";
const DEFAULT_BREAK_HOURS_AUTO_CHECKOUT = 1;
const DEFAULT_OVERTIME_THRESHOLD_MINUTES = 480;
const FALLBACK_TZ_OFFSET_MINUTES = 0;

interface OpenAttendanceRecord {
  id: number;
  orgId: string;
  userId: string;
  checkIn: Date | null;
  autoCheckedOut: boolean;
  date: string;
  breaks: { start: string; end?: string }[];
  breakHours: string;
}

type DueAttendanceRecord = OpenAttendanceRecord & { checkIn: Date };

interface ResolvedPolicies {
  attendance: Map<string, AttendancePolicyRules>;
  overtime: Map<string, OvertimePolicyRules>;
}

interface MissedPunch {
  userId: string;
  date: string;
}

const policyKey = (userId: string, date: string): string => `${userId}|${date}`;

@Injectable()
export class CronAttendanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly automations: HrAutomationEngineService,
    private readonly policyService: AttendancePolicyService,
  ) {}

  async processAutoCheckout(): Promise<{ processed: number; message: string }> {
    let processed = 0;
    const now = Date.now();

    await forEachOrg(this.db, "auto-checkout", async (tx, orgId) => {
      const openRecords: OpenAttendanceRecord[] = await tx.query.attendance.findMany({
        where: and(eq(attendance.orgId, orgId), isNull(attendance.checkOut)),
        columns: {
          id: true,
          orgId: true,
          userId: true,
          checkIn: true,
          autoCheckedOut: true,
          date: true,
          breaks: true,
          breakHours: true,
        },
      });

      const dueRecords = openRecords.filter(
        (record): record is DueAttendanceRecord =>
          record.checkIn !== null && !record.autoCheckedOut && record.date !== "",
      );
      if (dueRecords.length === 0) return;

      const policies = await this.resolvePolicies(orgId, dueRecords);

      const writes: BulkUpdateRow[] = [];
      const missedPunches = new Map<number, MissedPunch>();

      for (const record of dueRecords) {
        const key = policyKey(record.userId, record.date);
        const autoCheckoutTime =
          policies.attendance.get(key)?.autoCheckoutTime ?? DEFAULT_AUTO_CHECKOUT_TIME;
        const dailyThresholdHours =
          (policies.overtime.get(key)?.dailyThresholdMinutes ??
            DEFAULT_OVERTIME_THRESHOLD_MINUTES) / 60;

        const checkOutTime = this.policyService.parseAutoCheckoutTimeToUtc(
          autoCheckoutTime,
          record.date,
          FALLBACK_TZ_OFFSET_MINUTES,
        );

        if (checkOutTime.getTime() > now) continue;

        const checkOutAt = checkOutTime.toISOString();

        if (record.checkIn >= checkOutTime) {
          writes.push({
            key: record.id,
            values: [
              checkOutAt,
              "0",
              record.breakHours,
              JSON.stringify(record.breaks),
              "CHECKED_OUT",
              true,
              false,
            ],
          });
          continue;
        }

        const breaks = record.breaks;
        let totalBreakHours = Number(record.breakHours) || 0;

        for (const b of breaks) {
          if (!b.end) {
            b.end = checkOutAt;
            const breakStart = new Date(b.start);
            const breakDuration = (checkOutTime.getTime() - breakStart.getTime()) / (1000 * 60 * 60);
            totalBreakHours += Math.max(0, breakDuration);
          }
        }

        const effectiveBreakHours = Math.max(totalBreakHours, DEFAULT_BREAK_HOURS_AUTO_CHECKOUT);
        const durationMs = checkOutTime.getTime() - record.checkIn.getTime();
        const workHours = Math.max(0, durationMs / (1000 * 60 * 60) - effectiveBreakHours);

        writes.push({
          key: record.id,
          values: [
            checkOutAt,
            workHours.toFixed(2),
            effectiveBreakHours.toFixed(2),
            JSON.stringify(breaks),
            "CHECKED_OUT",
            true,
            workHours > dailyThresholdHours,
          ],
        });
        missedPunches.set(record.id, { userId: record.userId, date: record.date });
      }

      if (writes.length === 0) return;

      /*
       * One statement for the whole sweep. Every record closes at its own policy's
       * time with its own hours, so the batched form is `UPDATE … FROM (VALUES …)`;
       * the `check_out IS NULL` compare-and-set the per-row update relied on rides
       * in `extraWhere`, so a record someone closed meanwhile is still skipped and
       * still absent from the returned keys.
       */
      const closed = await bulkUpdateFromValues(tx, {
        table: attendance,
        orgId,
        key: { column: "id", type: "integer" },
        columns: [
          { column: "check_out", type: "timestamp" },
          { column: "work_hours", type: "numeric" },
          { column: "break_hours", type: "numeric" },
          { column: "breaks", type: "jsonb" },
          { column: "status", type: "text" },
          { column: "auto_checked_out", type: "boolean" },
          { column: "is_overtime", type: "boolean" },
        ],
        rows: writes,
        extraWhere: isNull(attendance.checkOut),
      });

      processed += closed.length;

      for (const id of closed) {
        const punch = missedPunches.get(Number(id));
        if (punch === undefined) continue;
        this.automations
          .emit(orgId, "attendance.missed_punch", { employeeId: punch.userId, date: punch.date })
          .catch(() => undefined);
      }
    });

    return {
      processed,
      message: `Auto-checked out ${processed} attendance records`,
    };
  }

  /**
   * Both policies for every record, resolved once per distinct date.
   *
   * A sweep reads far more open records than it does distinct `(employee, date)`
   * pairs, and the two resolutions used to run per record. The policy service
   * already answers for a set of employees on one date, so this collapses to two
   * round trips per date rather than two per record.
   */
  private async resolvePolicies(
    orgId: string,
    records: ReadonlyArray<{ userId: string; date: string }>,
  ): Promise<ResolvedPolicies> {
    const employeesByDate = new Map<string, Set<string>>();
    for (const record of records) {
      const employees = employeesByDate.get(record.date) ?? new Set<string>();
      employees.add(record.userId);
      employeesByDate.set(record.date, employees);
    }

    const attendanceRules = new Map<string, AttendancePolicyRules>();
    const overtimeRules = new Map<string, OvertimePolicyRules>();

    for (const [date, employees] of employeesByDate) {
      const employeeIds = [...employees];
      const [attendanceForDate, overtimeForDate] = await Promise.all([
        this.policyService.getAttendanceRulesForEmployees(orgId, employeeIds, date),
        this.policyService.getOvertimeRulesForEmployees(orgId, employeeIds, date),
      ]);
      for (const [employeeId, rules] of attendanceForDate)
        attendanceRules.set(policyKey(employeeId, date), rules);
      for (const [employeeId, rules] of overtimeForDate)
        overtimeRules.set(policyKey(employeeId, date), rules);
    }

    return { attendance: attendanceRules, overtime: overtimeRules };
  }
}
