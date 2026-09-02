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
