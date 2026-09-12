export interface CalendarSourceContext {
  orgId: string;
  userId: string;
  start: Date;
  end: Date;
}

export interface CalendarEventProjection<
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  color?: string | null;
  category: string;
  meta: TMeta;
}

export interface CalendarSourceLoadResult {
  events: CalendarEventProjection[];
  truncated: boolean;
}

export type CalendarSourceLoad = CalendarEventProjection[] | CalendarSourceLoadResult;

export function sourceLoadEvents(load: CalendarSourceLoad): CalendarEventProjection[] {
  return Array.isArray(load) ? load : load.events;
}

export function sourceLoadTruncated(load: CalendarSourceLoad): boolean {
  return Array.isArray(load) ? false : load.truncated;
}

export interface CalendarEventSource {
  readonly key: string;
  readonly label: string;
  readonly module: string;
  // Access filtering is the source's responsibility; the registry never filters the rows it receives.
  load(ctx: CalendarSourceContext): Promise<CalendarSourceLoad>;
}
