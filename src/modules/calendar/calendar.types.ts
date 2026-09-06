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
  timezone?: string | null;
  location?: string | null;
  description?: string | null;
  creatorName?: string | null;
  entityId?: string | null;
  entityType?: string | null;
  myRsvpStatus?: string | null;
  projectId?: number | null;
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
