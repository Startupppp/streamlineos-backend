import type { DataScope } from "../access/access.types";

export interface CalendarSourceContext {
  orgId: string;
  userId: string;
  start: Date;
  end: Date;
  scope: DataScope;
}

export interface CalendarEventProjection<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  color?: string | null;
  category: string;
  meta: TMeta;
}

export interface CalendarEventSource {
  readonly key: string;
  readonly label: string;
  readonly module: string;
  // Access filtering is the source's responsibility; the registry never filters the rows it receives.
  load(ctx: CalendarSourceContext): Promise<CalendarEventProjection[]>;
}
