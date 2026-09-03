export interface LinkedTicket {
  id: number;
  key: string;
  title: string;
  projectId: number;
  status: string;
}

export interface SourceFailure {
  key: string;
  label: string;
}

export interface CalendarEventsResult {
  events: CalendarEventItem[];
  failures: ReadonlyArray<SourceFailure>;
  truncated: boolean;
}

export interface CalendarEventItem {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  color?: string | null;
  category: string;
  source: "event" | "leave" | "interview" | "task" | "holiday" | "attendance";
  /**
   * IANA zone the event was authored in. `start`/`end` are absolute instants, so
   * a client that renders them in the browser's zone is correct about the moment
   * and wrong about the label — a 09:00 Asia/Kolkata standup reads as 03:30 GMT
   * with no way to tell it was not scheduled at 03:30. Aggregate sources that
   * have no authored zone (holidays, leave, attendance) carry `null`.
   */
  timezone?: string | null;
  location?: string | null;
  meetingUrl?: string | null;
  description?: string | null;
  creatorName?: string | null;
  entityId?: string | null;
  entityType?: string | null;
  myRsvpStatus?: string | null;
  projectId?: number | null;
  linkedTicket?: LinkedTicket | null;
  /**
   * The recurrence rule the occurrence was expanded from, and whether there was one.
   *
   * Both are computed by `CalendarNativeEventSource.load` — it reads `event.rrule` off
   * the row and derives `isRecurring` from it on the line above the projection — and
   * until 2026-09-03 both were discarded there. The browser client has declared
   * `rrule` and `isRecurring` on this item for as long as the aggregate has existed
   * and reads them in two places, so both were permanently `undefined`:
   * `features/calendar/event-detail-sheet.tsx:147` never rendered the "Cancel
   * occurrence" button for any recurring event, and
   * `features/calendar/use-event-create-dialog.ts:225` never opened the series-scope
   * prompt when editing one. Neither repository could see it: the client's type is
   * hand-written and both fields are optional, so both sides typechecked clean while
   * two features were unreachable — the same defect that shipped as an empty
   * Favourites list and as huddle tiles reading "Unknown".
   *
   * Non-native sources (leave, holidays, interviews, tasks, attendance) have no
   * recurrence rule and send `null`/`false`.
   */
  rrule?: string | null;
  isRecurring?: boolean;
}

export interface OooConflict {
  userId: string;
  userName: string | null;
  leaveStart: string;
  leaveEnd: string;
}

export function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
