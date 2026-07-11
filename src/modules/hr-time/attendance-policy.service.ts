import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { employeeShiftAssignments, rosterEntries, shiftTemplates } from "../../db/schema";
import { HrPolicyEvaluationService } from "../hr-policies/hr-policy-evaluation.service";

const DEFAULT_GRACE_MINUTES = 15;
const DEFAULT_SHIFT_START = "09:00";
const DEFAULT_OVERTIME_THRESHOLD_MINUTES = 480;
const DEFAULT_AUTO_CHECKOUT_TIME = "19:00";
const DEFAULT_BREAK_MINUTES_AUTO_CHECKOUT = 60;
const DEFAULT_RECLOCK_IN_COOLDOWN_MINUTES = 2;
const DEFAULT_ENFORCE_GEOFENCE = false;

export interface AttendancePolicyRules {
  graceMinutes: number;
  autoCheckoutTime: string;
  lateArrivalPenalty: string;
  halfDayThresholdMinutes: number;
  absentThresholdMinutes: number;
  enforceGeofence: boolean;
  minReclockInMinutes: number;
}

export interface OvertimePolicyRules {
  dailyThresholdMinutes: number;
}

export interface EffectiveShift {
  startTime: string;
  endTime: string;
  breakMinutes: number;
  gracePeriodMinutes: number;
}

@Injectable()
export class AttendancePolicyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly policyEval: HrPolicyEvaluationService,
  ) {}

  async getAttendanceRules(orgId: string, employeeId: string, date: string): Promise<AttendancePolicyRules> {
    const result = await this.policyEval.evaluatePolicy(orgId, employeeId, "attendance", date);
    const rules = result?.rules ?? {};
    return {
      graceMinutes: typeof rules["graceMinutes"] === "number" ? rules["graceMinutes"] : DEFAULT_GRACE_MINUTES,
      autoCheckoutTime: typeof rules["autoCheckoutTime"] === "string" ? rules["autoCheckoutTime"] : DEFAULT_AUTO_CHECKOUT_TIME,
      lateArrivalPenalty: typeof rules["lateArrivalPenalty"] === "string" ? rules["lateArrivalPenalty"] : "none",
      halfDayThresholdMinutes: typeof rules["halfDayThresholdMinutes"] === "number" ? rules["halfDayThresholdMinutes"] : 240,
      absentThresholdMinutes: typeof rules["absentThresholdMinutes"] === "number" ? rules["absentThresholdMinutes"] : 0,
      enforceGeofence: typeof rules["enforceGeofence"] === "boolean" ? rules["enforceGeofence"] : DEFAULT_ENFORCE_GEOFENCE,
      minReclockInMinutes: typeof rules["minReclockInMinutes"] === "number" ? rules["minReclockInMinutes"] : DEFAULT_RECLOCK_IN_COOLDOWN_MINUTES,
    };
  }

  async getOvertimeRules(orgId: string, employeeId: string, date: string): Promise<OvertimePolicyRules> {
    const result = await this.policyEval.evaluatePolicy(orgId, employeeId, "overtime", date);
    const rules = result?.rules ?? {};
    return {
      dailyThresholdMinutes: typeof rules["dailyThresholdMinutes"] === "number" ? rules["dailyThresholdMinutes"] : DEFAULT_OVERTIME_THRESHOLD_MINUTES,
    };
  }

  async getEffectiveShift(orgId: string, employeeId: string, date: string): Promise<EffectiveShift | null> {
    const rosterShiftRows = await this.db
      .select({
        startTime: shiftTemplates.startTime,
        endTime: shiftTemplates.endTime,
        breakMinutes: shiftTemplates.breakMinutes,
        gracePeriodMinutes: shiftTemplates.gracePeriodMinutes,
      })
      .from(rosterEntries)
      .innerJoin(shiftTemplates, eq(shiftTemplates.id, rosterEntries.shiftId))
      .where(and(eq(rosterEntries.userId, employeeId), eq(rosterEntries.date, date)))
      .limit(1);

    const rosterShift = rosterShiftRows[0];
    if (rosterShift) {
      return {
        startTime: rosterShift.startTime,
        endTime: rosterShift.endTime,
        breakMinutes: rosterShift.breakMinutes,
        gracePeriodMinutes: rosterShift.gracePeriodMinutes,
      };
    }

    const assignment = await this.db
      .select({
        startTime: shiftTemplates.startTime,
        endTime: shiftTemplates.endTime,
        breakMinutes: shiftTemplates.breakMinutes,
        gracePeriodMinutes: shiftTemplates.gracePeriodMinutes,
      })
      .from(employeeShiftAssignments)
      .innerJoin(shiftTemplates, eq(shiftTemplates.id, employeeShiftAssignments.shiftId))
      .where(
        and(
          eq(employeeShiftAssignments.userId, employeeId),
          eq(employeeShiftAssignments.orgId, orgId),
          eq(employeeShiftAssignments.isActive, true),
          lte(employeeShiftAssignments.effectiveFrom, date),
          or(isNull(employeeShiftAssignments.effectiveTo), lte(employeeShiftAssignments.effectiveTo, date)),
        ),
      )
      .limit(1);

    const found = assignment[0];
    if (found) {
      return {
        startTime: found.startTime,
        endTime: found.endTime,
        breakMinutes: found.breakMinutes,
        gracePeriodMinutes: found.gracePeriodMinutes,
      };
    }

    return null;
  }

  async getEffectiveShiftStartWithGrace(
    orgId: string,
    employeeId: string,
    date: string,
  ): Promise<{ shiftStartMinutes: number; graceMinutes: number }> {
    const shift = await this.getEffectiveShift(orgId, employeeId, date);
    if (shift) {
      const [hStr, mStr] = shift.startTime.split(":");
      const shiftStartMinutes = Number(hStr) * 60 + Number(mStr);
      return { shiftStartMinutes, graceMinutes: shift.gracePeriodMinutes };
    }

    const rules = await this.getAttendanceRules(orgId, employeeId, date);
    const [hStr, mStr] = DEFAULT_SHIFT_START.split(":");
    const shiftStartMinutes = Number(hStr) * 60 + Number(mStr);
    return { shiftStartMinutes, graceMinutes: rules.graceMinutes };
  }

  parseAutoCheckoutTimeToUtc(timeStr: string, dateStr: string, tzOffsetMinutes: number): Date {
    const [hStr, mStr] = timeStr.split(":");
    const localMinutes = Number(hStr) * 60 + Number(mStr);
    const utcMinutes = ((localMinutes - tzOffsetMinutes) % 1440 + 1440) % 1440;
    const utcHours = Math.floor(utcMinutes / 60);
    const utcMins = utcMinutes % 60;
    const parts = dateStr.split("-");
    return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), utcHours, utcMins, 0, 0));
  }

  getDefaultAutoCheckoutBreakMinutes(): number {
    return DEFAULT_BREAK_MINUTES_AUTO_CHECKOUT;
  }
}
