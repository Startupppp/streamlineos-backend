import {
  resolveProvider,
  type ProviderBlocked,
  type ProviderCredentials,
} from "../../recruitment/integrations/provider-blocked";
import type { Interval } from "./free-busy";

/** The calendars the integration catalog knows about. */
export const CALENDAR_PLATFORMS = ["GOOGLE_CALENDAR", "MICROSOFT_GRAPH"] as const;
export type CalendarPlatform = (typeof CALENDAR_PLATFORMS)[number];

export interface FreeBusyQuery {
  /** The calendar addresses to ask about — one per panel member. */
  emails: readonly string[];
  window: Interval;
}

export interface CalendarAdapter {
  /**
   * Busy blocks per address. An address the provider does not recognise must be
   * absent from the map rather than present and empty: absent reads as "we
   * could not see this person", empty reads as "this person is free all week",
   * and only one of those is safe to schedule against.
   */
  freeBusy(
    credentials: ProviderCredentials,
    query: FreeBusyQuery,
  ): Promise<ReadonlyMap<string, Interval[]>>;
}

/**
 * Empty, and that is the honest state.
 *
 * Google Calendar needs a Cloud OAuth client with Calendar scopes and Microsoft
 * needs an Entra app registration with `Calendars.Read`; this deployment holds
 * neither. An adapter that returned an empty busy list would be worse than
 * none: every interviewer would look free all week and the scheduler would book
 * straight over their existing meetings with complete confidence.
 *
 * `interview-availability.service.ts` falls back to the interviews
 * StreamlineOS already holds, which is a real and correct answer for the
 * conflicts it can see, and reports that the rest were not visible.
 */
export const CALENDAR_ADAPTERS: ReadonlyMap<CalendarPlatform, CalendarAdapter> = new Map();

export function resolveCalendar(
  platform: CalendarPlatform,
  credentials: ProviderCredentials | null,
): { adapter: CalendarAdapter; credentials: ProviderCredentials } | ProviderBlocked {
  return resolveProvider(
    platform,
    credentials,
    CALENDAR_ADAPTERS,
    "calendar free/busy",
    "Offer slots by hand; the candidate still books one and still gets an ICS file.",
  );
}
