import { z } from "zod";

export const TOOL_SLUGS = {
  googleList: "GOOGLECALENDAR_EVENTS_LIST",
  googleCreate: "GOOGLECALENDAR_CREATE_EVENT",
  googleUpdate: "GOOGLECALENDAR_UPDATE_EVENT",
  googleDelete: "GOOGLECALENDAR_DELETE_EVENT",
  outlookList: "OUTLOOK_GET_CALENDAR_VIEW",
  outlookCreate: "OUTLOOK_CALENDAR_CREATE_EVENT",
} as const;

export interface ProviderCapabilities {
  create: boolean;
  update: boolean;
  delete: boolean;
  /**
   * Whether a push can carry the series' RRULE, and therefore whether a recurring
   * event can be represented at the provider at all.
   *
   * `PushEventInput` used to have no rrule field, so a weekly series synced to a
   * provider landed as ONE meeting at the first occurrence and stayed that way —
   * divergence from the very first push, with nothing anywhere reporting it. Google
   * takes `recurrence: ["RRULE:…"]`; the Outlook create tool exposes no recurrence
   * argument, so the honest answer there is a refused push (visible as `failed`),
   * never a silently-wrong single meeting.
   */
  recurrence: boolean;
  /**
   * Whether ONE occurrence of a series can be addressed on its own. Google names an
   * instance `<masterId>_<basic-UTC-instant>`, so a moved or cancelled occurrence can
   * be pushed without overwriting the series.
   */
  occurrence: boolean;
}

export const PROVIDER_CAPABILITIES: Record<"googlecalendar" | "outlook", ProviderCapabilities> = {
  googlecalendar: { create: true, update: true, delete: true, recurrence: true, occurrence: true },
  outlook: { create: true, update: false, delete: false, recurrence: false, occurrence: false },
} as const;

/**
 * A push the provider cannot express — not a transient failure.
 *
 * Retrying it can never succeed, so the sweep marks the queue row FAILED on the first
 * attempt with this reason rather than burning the backoff ladder. It must NEVER be
 * swallowed: a refused push that is marked PROCESSED reports `synced` over a provider
 * copy that is stale or missing, and `retrySync` (FAILED-only) can never reach it.
 */
export class ProviderCapabilityError extends Error {
  readonly permanent = true;

  constructor(reason: string) {
    super(reason);
    this.name = "ProviderCapabilityError";
  }
}

/**
 * Google addresses one instance of a recurring event as `<masterId>_<YYYYMMDDTHHMMSSZ>`,
 * built from the occurrence's NOMINAL UTC instant — the one the RRULE generated, which is
 * also `calendar_event_exceptions.occurrence_start`. An all-day series uses the date form.
 */
export function googleInstanceEventId(
  masterEventId: string,
  nominalStart: Date,
  allDay = false,
): string {
  const iso = nominalStart.toISOString();
  const compact = allDay
    ? iso.slice(0, 10).replace(/-/g, "")
    : `${iso.slice(0, 19).replace(/[-:]/g, "")}Z`;
  return `${masterEventId}_${compact}`;
}

export interface ExternalCalendarEventItem {
  id: string;
  connectionId: number;
  toolkit: "googlecalendar" | "outlook";
  accountEmail: string | null;
  providerEventId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  meetingUrl: string | null;
  webLink: string | null;
}

const googleEventSchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  status: z.string().optional(),
  location: z.string().optional(),
  hangoutLink: z.string().optional(),
  htmlLink: z.string().optional(),
  start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
  end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
});

const googleListSchema = z.object({ items: z.array(z.unknown()).optional() });

const graphDateSchema = z.object({ dateTime: z.string(), timeZone: z.string().optional() });

const outlookEventSchema = z.object({
  id: z.string(),
  subject: z.string().nullable().optional(),
  isAllDay: z.boolean().optional(),
  isCancelled: z.boolean().optional(),
  webLink: z.string().optional(),
  onlineMeeting: z.object({ joinUrl: z.string().optional() }).nullable().optional(),
  location: z.object({ displayName: z.string().optional() }).nullable().optional(),
  start: graphDateSchema,
  end: graphDateSchema,
});

const outlookListSchema = z.object({ value: z.array(z.unknown()).optional() });

export function unwrapComposioData(data: unknown): unknown {
  if (data !== null && typeof data === "object" && "response_data" in data) {
    return (data as Record<string, unknown>).response_data;
  }
  return data;
}

function graphToIso(value: z.infer<typeof graphDateSchema>): string {
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value.dateTime)) return new Date(value.dateTime).toISOString();
  const raw = value.dateTime.replace(/\.\d+$/, "");
  return new Date(`${raw}Z`).toISOString();
}

interface ConnectionMeta {
  id: number;
  accountEmail: string | null;
}

export function normalizeGoogleEvents(data: unknown, conn: ConnectionMeta): ExternalCalendarEventItem[] {
  const list = googleListSchema.parse(unwrapComposioData(data));
  const items: ExternalCalendarEventItem[] = [];
  for (const raw of list.items ?? []) {
    const parsed = googleEventSchema.safeParse(raw);
    if (!parsed.success) continue;
    const ev = parsed.data;
    if (ev.status === "cancelled") continue;
    const allDay = Boolean(ev.start.date);
    const start = ev.start.dateTime ?? ev.start.date;
    const end = ev.end.dateTime ?? ev.end.date;
    if (!start || !end) continue;
    items.push({
      id: `ext-${conn.id}-${ev.id}`,
      connectionId: conn.id,
      toolkit: "googlecalendar",
      accountEmail: conn.accountEmail,
      providerEventId: ev.id,
      title: ev.summary ?? "(no title)",
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      allDay,
      location: ev.location ?? null,
      meetingUrl: ev.hangoutLink ?? null,
      webLink: ev.htmlLink ?? null,
    });
  }
  return items;
}

export function normalizeOutlookEvents(data: unknown, conn: ConnectionMeta): ExternalCalendarEventItem[] {
  const list = outlookListSchema.parse(unwrapComposioData(data));
  const items: ExternalCalendarEventItem[] = [];
  for (const raw of list.value ?? []) {
    const parsed = outlookEventSchema.safeParse(raw);
    if (!parsed.success) continue;
    const ev = parsed.data;
    if (ev.isCancelled) continue;
    items.push({
      id: `ext-${conn.id}-${ev.id}`,
      connectionId: conn.id,
      toolkit: "outlook",
      accountEmail: conn.accountEmail,
      providerEventId: ev.id,
      title: ev.subject ?? "(no title)",
      start: graphToIso(ev.start),
      end: graphToIso(ev.end),
      allDay: ev.isAllDay ?? false,
      location: ev.location?.displayName ?? null,
      meetingUrl: ev.onlineMeeting?.joinUrl ?? null,
      webLink: ev.webLink ?? null,
    });
  }
  return items;
}
