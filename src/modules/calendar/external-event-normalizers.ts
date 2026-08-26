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
}

export const PROVIDER_CAPABILITIES: Record<"googlecalendar" | "outlook", ProviderCapabilities> = {
  googlecalendar: { create: true, update: true, delete: true },
  outlook: { create: true, update: false, delete: false },
} as const;

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
