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
  /** False when the organisation has not turned the policy on. Nothing was read or written. */
  enabled: boolean;
  segmentsFound: number;
  entriesCreated: number;
  /** Days that already had an entry. Not an error — the whole point of running twice. */
  skippedExisting: number;
  /** Days whose clock produced no usable hours. */
  skippedEmpty: number;
  periodIds: number[];
}

/** A window longer than this is refused rather than silently truncated. */
const MAX_RANGE_DAYS = 62;

function clockLabel(iso: string): string {
  return iso.slice(11, 16);
}

/**
 * TS-09. Turns completed clock days into draft timesheet entries.
 *
 * Three things make this safe to run repeatedly, which matters because the only
 * sensible way to offer it is a button somebody can press twice:
 *
 *   1. **The policy flag.** `timesheet_settings.auto_draft_from_attendance`
 *      defaults to false. Attendance records presence; a timesheet records what
 *      the work was and is signed by an approver. An organisation that clocks
 *      people in has not thereby asked for hours it never saw to appear on a
 *      timesheet somebody must submit.
 *
 *   2. **The database, not a read-then-write.** `uniq_timesheets_work_log` is
 *      UNIQUE on `(org_id, user_membership_id, date) WHERE ticket_id IS NULL`,
 *      so a day-level entry with no ticket already cannot exist twice. Inserting
 *      with `ON CONFLICT DO NOTHING` against that index makes double-creation
 *      impossible rather than unlikely — a check-then-insert would still lose a
 *      race with the person entering the same day by hand.
 *
 *   3. **It never overwrites.** A conflict is skipped, not updated. If somebody
 *      has already written what they did that day, the clock is not a better
 *      source of truth than they are.
 *
 * A day that was never checked out yields no segment at all — see
 * `clockSegmentsFrom`. That is deliberate upstream and load-bearing here: an
 * open day would otherwise become an entry ending "now", which is a guess
 * written into a timesheet as a fact.
 */
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

    /**
     * No settings row is "not enabled", not "use the default". The column's
     * default is false, so an organisation that has never opened the settings
     * screen has not opted in either way.
     */
    if (!settings?.autoDraft) return empty;

    /**
     * Entries and periods belong to a membership since the actor cutover
     * (0715), resolved from the session the way `EntriesService` resolves it.
     * After the policy check, so an organisation that has not opted in answers
     * "not enabled" to every caller. The clock itself is HR's `attendance`,
     * which is keyed by user, so the port is still asked by user id.
     */
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
          /**
           * Not billable, and not a guess at a project. The clock says a person
           * was present; it does not say what for, and inventing a billable
           * project would put a number on an invoice that nobody chose.
           */
          isBillable: false,
          billingType: "NON_BILLABLE",
          /**
           * `IMPORT` because the entry did not come from a person typing or a
           * timer running. The enum has no ATTENDANCE member and adding one
           * means `ALTER TYPE … ADD VALUE`, whose new label cannot be used in
           * the transaction that adds it — not worth the operational edge for a
           * label. Provenance is unambiguous in the description.
           */
          source: "IMPORT",
          timesheetPeriodId: periodId,
          status: "PENDING",
        })
        /**
         * The partial index's predicate is repeated verbatim. Postgres refuses
         * an `ON CONFLICT` naming columns covered only by a partial index
         * unless the predicate is restated, and the failure is a hard 42P10
         * rather than a quiet fallback to a full-table conflict. On
         * `onConflictDoNothing` the key is `where`; `targetWhere` is the
         * `onConflictDoUpdate` spelling of the same thing and is ignored here.
         */
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

/**
 * Says where the number came from, in the row a person will read.
 *
 * `autoCheckedOut` is carried through rather than hidden: a day the sweep
 * closed has an end time nobody chose, and an approver looking at the hours
 * deserves to know which of them is an estimate.
 */
function describeSegment(segment: ClockSegment): string {
  const window = `${clockLabel(segment.startedAt)}–${clockLabel(segment.endedAt)}`;
  const breaks = segment.breakMinutes > 0 ? `, ${segment.breakMinutes}m break` : "";
  const auto = segment.autoCheckedOut ? " (auto checked out)" : "";
  return `Drafted from attendance ${window}${breaks}${auto}`;
}

/** Exported for the spec: the sentence a person reads is worth pinning. */
export const attendanceDraftInternals = { describeSegment, MAX_RANGE_DAYS };
