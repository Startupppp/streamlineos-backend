import { ConflictException, Inject, Injectable, Logger, UnprocessableEntityException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { timesheets, timesheetSettings } from "../../../../db/schema";
import { EntriesPeriodService } from "../entries-period.service";
import { TimesheetsAuditService } from "../timesheets-audit.service";
import { TIMESHEET_ATTENDANCE_PORT, type TimesheetAttendancePort } from "./attendance.port";
import { segmentHours, type ClockSegment } from "./lib/clock-segments";
import { actingMembershipId } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

export interface AttendanceDraftResult {
  enabled: boolean;
  segmentsFound: number;
  entriesCreated: number;
  skippedExisting: number;
  skippedEmpty: number;
  periodIds: number[];
}

const MAX_RANGE_DAYS = 62;

function clockLabel(iso: string): string {
  return iso.slice(11, 16);
}

@Injectable()
export class AttendanceDraftService {
  private readonly logger = new Logger(AttendanceDraftService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(TIMESHEET_ATTENDANCE_PORT) private readonly attendance: TimesheetAttendancePort,
    private readonly periods: EntriesPeriodService,
    private readonly audit: TimesheetsAuditService,
  ) {}

  async draftForUser(
    u: CurrentUserContext,
    range: { start: string; end: string },
  ): Promise<AttendanceDraftResult> {
    if (range.end < range.start) {
      throw new ConflictException("The end of the range is before its start");
    }
    const days =
      (Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86_400_000;
    if (days > MAX_RANGE_DAYS) {
      throw new ConflictException(
        `Draft at most ${MAX_RANGE_DAYS} days of attendance at a time; asked for ${days + 1}`,
      );
    }

    const [settings] = await this.db
      .select({
        autoDraft: timesheetSettings.autoDraftFromAttendance,
        workWeekStart: timesheetSettings.workWeekStart,
      })
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, u.orgId))
      .limit(1);

    const empty: AttendanceDraftResult = {
      enabled: false,
      segmentsFound: 0,
      entriesCreated: 0,
      skippedExisting: 0,
      skippedEmpty: 0,
      periodIds: [],
    };

    if (!settings?.autoDraft) return empty;

    const membershipId = actingMembershipId(u.principal);
    if (membershipId === null) {
      throw new UnprocessableEntityException("No active membership for this session");
    }

    const segments = await this.attendance.getClockSegments(u.orgId, u.userId, range);
    if (segments.length === 0) return { ...empty, enabled: true };

    const result: AttendanceDraftResult = { ...empty, enabled: true, segmentsFound: segments.length };
    const periodIds = new Set<number>();

    for (const segment of segments) {
      const hours = segmentHours(segment);
      if (hours <= 0) {
        result.skippedEmpty++;
        continue;
      }

      const periodId = await this.periods.getOrCreatePeriod(
        u.orgId,
        membershipId,
        segment.date,
        settings.workWeekStart ?? 1,
      );

      const inserted = await this.db
        .insert(timesheets)
        .values({
          orgId: u.orgId,
          userMembershipId: membershipId,
          date: segment.date,
          hours: hours.toFixed(2),
          description: describeSegment(segment),
          isBillable: false,
          billingType: "NON_BILLABLE",
          source: "IMPORT",
          timesheetPeriodId: periodId,
          status: "PENDING",
        })
        .onConflictDoNothing({
          target: [timesheets.orgId, timesheets.userMembershipId, timesheets.date],
          where: sql`ticket_id IS NULL`,
        })
        .returning({ id: timesheets.id });

      periodIds.add(periodId);
      if (inserted.length > 0) result.entriesCreated++;
      else result.skippedExisting++;
    }

    for (const periodId of periodIds) {
      await this.periods.recomputePeriodTotals(u.orgId, periodId);
    }
    result.periodIds = [...periodIds];

    if (result.entriesCreated > 0) {
      await this.db.transaction(async (tx) => {
        await this.audit.record(tx, {
          orgId: u.orgId,
          actorMembershipId: membershipId,
          entityType: "entry",
          entityId: `attendance:${range.start}..${range.end}`,
          action: "entries.drafted_from_attendance",
          after: {
            created: result.entriesCreated,
            skippedExisting: result.skippedExisting,
            segments: result.segmentsFound,
          },
        });
      });
      this.logger.debug(
        `drafted ${result.entriesCreated} entr(ies) from attendance for ${u.userId} in ${u.orgId}`,
      );
    }

    return result;
  }
}

function describeSegment(segment: ClockSegment): string {
  const window = `${clockLabel(segment.startedAt)}–${clockLabel(segment.endedAt)}`;
  const breaks = segment.breakMinutes > 0 ? `, ${segment.breakMinutes}m break` : "";
  const auto = segment.autoCheckedOut ? " (auto checked out)" : "";
  return `Drafted from attendance ${window}${breaks}${auto}`;
}
