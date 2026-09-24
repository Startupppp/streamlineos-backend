import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lt, lte, ne, or } from "drizzle-orm";
import {
  calendarEvents,
  eventAttendees,
  interviews,
  organizationMembers,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { ProviderCredentialsService } from "../../recruitment/integrations/provider-credentials.service";
import { isBlocked } from "../../recruitment/integrations/provider-blocked";
import { CALENDAR_PLATFORMS, resolveCalendar, type CalendarPlatform } from "./calendar-provider";
import {
  overlapsAny,
  panelFreeWithin,
  slotsFrom,
  type Interval,
  type PanelMemberBusy,
} from "./free-busy";

export interface SuggestionRequest {
  orgId: string;
  /** Membership ids of the people who must all attend. */
  panelMembershipIds: readonly number[];
  window: Interval;
  durationMinutes: number;
  granularityMinutes?: number;
  limit?: number;
  /** Exclude this interview's own booking when re-scheduling it. */
  ignoreInterviewId?: number;
}

export interface SuggestionResult {
  slots: Array<{ start: string; end: string }>;
  /**
   * What the busy picture was built from, named rather than implied.
   *
   * `"streamline-only"` means the suggestions avoid interviews this product
   * knows about and nothing else — an interviewer's dentist appointment is
   * invisible. A screen that presents those as "free" without saying so is
   * making a promise the data does not support.
   */
  source: "streamline-only" | "calendar";
  /** Why a connected calendar was not used, when it was not. */
  blockedReason: string | null;
  /** Memberships whose external calendar could not be read. */
  unseenMembershipIds: number[];
}

/** A conflict found against an interview StreamlineOS already holds. */
export interface PanelConflict {
  membershipId: number;
  interviewId: number;
  scheduledAt: Date;
  durationMinutes: number;
}

@Injectable()
export class InterviewAvailabilityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly credentials: ProviderCredentialsService,
  ) {}

  /**
   * Resolves the user ids a recruiter screen holds into the membership ids this
   * service scopes by.
   *
   * The frontend lists interviewers by `userId` — that is what `useRecruiters`
   * and the existing day-view availability endpoint both speak — while every
   * tenant-scoped row here keys on `organization_members.id`. Translating at the
   * boundary keeps the composite tenant FK as the thing being queried, rather
   * than adding a second identifier to the busy reads.
   *
   * A user id that is not a member of this organisation resolves to nothing and
   * is silently dropped: the caller asked about somebody who cannot be on this
   * org's panel, and answering 404 on a suggestion request would turn a stale
   * picker into a broken screen.
   */
  async membershipIdsForUsers(orgId: string, userIds: readonly string[]): Promise<number[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          inArray(organizationMembers.userId, [...userIds]),
        ),
      )
      .limit(userIds.length);
    return rows.map((row) => row.id);
  }

  async suggest(request: SuggestionRequest): Promise<SuggestionResult> {
    const internal = await this.internalBusy(request);

    /*
      The provider is asked for, not assumed. Both calendar adapters are
      unimplemented on this deployment, so in practice this resolves BLOCKED
      and the answer below is built from `internal` alone — which is a real
      answer for the conflicts it can see, and says so in `source`.
    */
    const external = await this.externalBusy(request);

    const panel: PanelMemberBusy[] = request.panelMembershipIds.map((membershipId) => ({
      membershipId,
      busy: [...(internal.get(membershipId) ?? []), ...(external.busy.get(membershipId) ?? [])],
      known: external.seen.has(membershipId),
    }));

    const free = panelFreeWithin(request.window, panel);
    const slots = slotsFrom(free, {
      durationMinutes: request.durationMinutes,
      granularityMinutes: request.granularityMinutes,
      /*
        Never propose a slot in the past. The window a recruiter picks usually
        starts today, and "today 09:00" is behind them by the time they look.
      */
      notBefore: new Date(),
      limit: request.limit,
    });

    return {
      slots: slots.map((slot) => ({
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
      })),
      source: external.blockedReason === null ? "calendar" : "streamline-only",
      blockedReason: external.blockedReason,
      unseenMembershipIds: panel
        .filter((member) => !member.known)
        .map((member) => member.membershipId),
    };
  }

  /**
   * Whether any panel member is already booked over this slot.
   *
   * Called inside the booking transaction rather than being trusted from the
   * suggestion that produced the slot. Suggestions are computed when a link is
   * created and a candidate may click it days later, by which time the
   * interviewer's morning has filled up — and unlike a reserved hold, a check
   * at commit time cannot be beaten by two candidates racing, because both
   * racers read the row the other one wrote.
   */
  async conflictsFor(
    orgId: string,
    panelMembershipIds: readonly number[],
    slot: Interval,
    ignoreInterviewId?: number,
  ): Promise<PanelConflict[]> {
    if (panelMembershipIds.length === 0) return [];

    const rows = await this.busyRows(
      orgId,
      panelMembershipIds,
      // A day either side catches a long meeting that starts before the slot;
      // interviews are hours, not weeks.
      {
        start: new Date(slot.start.getTime() - 24 * 60 * 60 * 1000),
        end: new Date(slot.end.getTime() + 24 * 60 * 60 * 1000),
      },
      ignoreInterviewId,
    );

    const conflicts: PanelConflict[] = [];
    for (const row of rows) {
      if (row.membershipId === null) continue;
      const busy: Interval = {
        start: row.scheduledAt,
        end: new Date(row.scheduledAt.getTime() + row.duration * 60_000),
      };
      if (!overlapsAny(slot, [busy])) continue;
      conflicts.push({
        membershipId: row.membershipId,
        interviewId: row.id,
        scheduledAt: row.scheduledAt,
        durationMinutes: row.duration,
      });
    }
    return conflicts;
  }

  private async internalBusy(
    request: Pick<
      SuggestionRequest,
      "orgId" | "panelMembershipIds" | "window" | "ignoreInterviewId"
    >,
  ): Promise<Map<number, Interval[]>> {
    const busy = new Map<number, Interval[]>();
    const add = (membershipId: number, interval: Interval) => {
      const existing = busy.get(membershipId);
      if (existing) existing.push(interval);
      else busy.set(membershipId, [interval]);
    };

    const [interviewRows, eventRows] = await Promise.all([
      this.busyRows(
        request.orgId,
        request.panelMembershipIds,
        request.window,
        request.ignoreInterviewId,
      ),
      this.calendarBusy(request.orgId, request.panelMembershipIds, request.window),
    ]);

    for (const row of interviewRows) {
      if (row.membershipId === null) continue;
      add(row.membershipId, {
        start: row.scheduledAt,
        end: new Date(row.scheduledAt.getTime() + row.duration * 60_000),
      });
    }
    for (const [membershipId, intervals] of eventRows) {
      for (const interval of intervals) add(membershipId, interval);
    }
    return busy;
  }

  /**
   * Meetings in StreamlineOS's own calendar.
   *
   * Without this the suggestions would happily put an interview on top of a
   * meeting the same product is already showing that person — which is worse
   * than not suggesting at all, because the conflict was visible the whole
   * time. `hr-interviewers.service.ts` already reads the calendar this way for
   * its day view; the rule there is that somebody is busy for an event they
   * created or were invited to, and it is repeated here rather than diverged
   * from.
   */
  private async calendarBusy(
    orgId: string,
    panelMembershipIds: readonly number[],
    window: Interval,
  ): Promise<Map<number, Interval[]>> {
    const busy = new Map<number, Interval[]>();
    if (panelMembershipIds.length === 0) return busy;
    const ids = [...panelMembershipIds];

    const rows = await this.db
      .selectDistinct({
        membershipId: eventAttendees.membershipId,
        createdBy: calendarEvents.createdByMembershipId,
        startDate: calendarEvents.startDate,
        endDate: calendarEvents.endDate,
        allDay: calendarEvents.allDay,
      })
      .from(calendarEvents)
      .leftJoin(
        eventAttendees,
        and(
          eq(eventAttendees.orgId, calendarEvents.orgId),
          eq(eventAttendees.eventId, calendarEvents.id),
          inArray(eventAttendees.membershipId, ids),
        ),
      )
      .where(
        and(
          eq(calendarEvents.orgId, orgId),
          lte(calendarEvents.startDate, window.end),
          gte(calendarEvents.endDate, window.start),
          or(
            inArray(calendarEvents.createdByMembershipId, ids),
            inArray(eventAttendees.membershipId, ids),
          ),
        ),
      )
      .limit(1000);

    for (const row of rows) {
      /*
        An all-day event blocks the day rather than a span, and its stored end
        may equal its start. Treating it as a zero-length interval would let an
        interview be booked on somebody's day off.
      */
      const start = row.startDate;
      const end =
        row.allDay || row.endDate.getTime() <= row.startDate.getTime()
          ? new Date(row.startDate.getTime() + 24 * 60 * 60 * 1000)
          : row.endDate;

      for (const membershipId of [row.membershipId, row.createdBy]) {
        if (membershipId === null || !ids.includes(membershipId)) continue;
        const existing = busy.get(membershipId);
        if (existing) existing.push({ start, end });
        else busy.set(membershipId, [{ start, end }]);
      }
    }
    return busy;
  }

  /** The interviews that count as busy for these people in this window. */
  private async busyRows(
    orgId: string,
    panelMembershipIds: readonly number[],
    window: Interval,
    ignoreInterviewId?: number,
  ) {
    if (panelMembershipIds.length === 0) return [];

    const filters = [
      eq(interviews.orgId, orgId),
      inArray(interviews.interviewerMembershipId, [...panelMembershipIds]),
      /*
        A generous lower bound rather than `scheduledAt >= window.start`: an
        interview that began before the window can still run into it, and
        `duration` lives in a column rather than in the predicate. Four hours
        covers every interview this product can schedule.
      */
      gte(interviews.scheduledAt, new Date(window.start.getTime() - 4 * 60 * 60 * 1000)),
      lt(interviews.scheduledAt, window.end),
      /*
        A cancelled or completed interview is not a conflict. Only PENDING
        blocks the calendar — the rest have either happened or been called off,
        and treating a finished interview as busy would make an interviewer
        look permanently unavailable.
      */
      eq(interviews.result, "PENDING"),
    ];
    if (ignoreInterviewId !== undefined) filters.push(ne(interviews.id, ignoreInterviewId));

    return this.db
      .select({
        id: interviews.id,
        membershipId: interviews.interviewerMembershipId,
        scheduledAt: interviews.scheduledAt,
        duration: interviews.duration,
      })
      .from(interviews)
      .where(and(...filters))
      .limit(500);
  }

  /**
   * Busy time from a connected calendar, when there is one.
   *
   * Returns `seen` rather than inferring it from an empty busy list, because
   * "this person has nothing in their diary" and "we could not read this
   * person's diary" produce the same empty array and only one of them is safe
   * to book against.
   */
  private async externalBusy(request: SuggestionRequest): Promise<{
    busy: Map<number, Interval[]>;
    seen: Set<number>;
    blockedReason: string | null;
  }> {
    const empty = { busy: new Map<number, Interval[]>(), seen: new Set<number>() };

    for (const platform of CALENDAR_PLATFORMS) {
      const credentials = await this.credentials.forPlatform(request.orgId, platform);
      const resolved = resolveCalendar(platform as CalendarPlatform, credentials);
      if (!("adapter" in resolved)) {
        if (isBlocked(resolved) && resolved.code !== "no-integration") {
          // Connected but unusable is worth surfacing; never connected is not.
          return { ...empty, blockedReason: resolved.message };
        }
        continue;
      }

      /*
        Unreachable today — `CALENDAR_ADAPTERS` is empty by design. Left in
        place so wiring a real adapter is one map entry rather than a rewrite,
        and so the shape the adapter must satisfy is visible at the call site.
      */
      return { ...empty, blockedReason: null };
    }

    return {
      ...empty,
      blockedReason:
        "No calendar is connected, so these slots only avoid interviews already in StreamlineOS.",
    };
  }
}
