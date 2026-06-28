import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { userCalendarConnections } from "../../db/schema";
import type { CalendarProvider } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { UpsertConnectionInput, CreateEventInput } from "./dto/calendar-connections.schemas";

type ConnectionRow = typeof userCalendarConnections.$inferSelect;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
}

export interface BusySlot {
  start: string;
  end: string;
}

@Injectable()
export class CalendarConnectionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  getConnections(userId: string) {
    return this.db
      .select({
        id: userCalendarConnections.id,
        provider: userCalendarConnections.provider,
        providerEmail: userCalendarConnections.providerEmail,
        isPrimary: userCalendarConnections.isPrimary,
        expiresAt: userCalendarConnections.expiresAt,
        updatedAt: userCalendarConnections.updatedAt,
      })
      .from(userCalendarConnections)
      .where(eq(userCalendarConnections.userId, userId))
      .orderBy(desc(userCalendarConnections.isPrimary), userCalendarConnections.id);
  }

  async upsertConnection(userId: string, input: UpsertConnectionInput): Promise<void> {
    const expiresAt = input.expiresIn
      ? new Date(Date.now() + input.expiresIn * 1000)
      : undefined;

    const existing = await this.db
      .select({ id: userCalendarConnections.id })
      .from(userCalendarConnections)
      .where(eq(userCalendarConnections.userId, userId));

    await this.db
      .insert(userCalendarConnections)
      .values({
        userId,
        provider: input.provider,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? null,
        expiresAt: expiresAt ?? null,
        providerEmail: input.providerEmail,
        isPrimary: existing.length === 0,
      })
      .onConflictDoUpdate({
        target: [
          userCalendarConnections.userId,
          userCalendarConnections.provider,
          userCalendarConnections.providerEmail,
        ],
        set: {
          accessToken: input.accessToken,
          ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
          ...(expiresAt ? { expiresAt } : {}),
        },
      });
  }

  async disconnect(connectionId: number, userId: string): Promise<boolean> {
    const [connection] = await this.db
      .select({ id: userCalendarConnections.id, isPrimary: userCalendarConnections.isPrimary })
      .from(userCalendarConnections)
      .where(
        and(
          eq(userCalendarConnections.id, connectionId),
          eq(userCalendarConnections.userId, userId),
        ),
      )
      .limit(1);

    if (!connection) return false;

    await this.db
      .delete(userCalendarConnections)
      .where(eq(userCalendarConnections.id, connectionId));

    if (connection.isPrimary) {
      const [next] = await this.db
        .select({ id: userCalendarConnections.id })
        .from(userCalendarConnections)
        .where(eq(userCalendarConnections.userId, userId))
        .orderBy(desc(userCalendarConnections.id))
        .limit(1);

      if (next) {
        await this.db
          .update(userCalendarConnections)
          .set({ isPrimary: true })
          .where(eq(userCalendarConnections.id, next.id));
      }
    }

    return true;
  }

  async setPrimary(connectionId: number, userId: string): Promise<boolean> {
    const [connection] = await this.db
      .select({ id: userCalendarConnections.id })
      .from(userCalendarConnections)
      .where(
        and(
          eq(userCalendarConnections.id, connectionId),
          eq(userCalendarConnections.userId, userId),
        ),
      )
      .limit(1);

    if (!connection) return false;

    await this.db.transaction(async (tx) => {
      await tx
        .update(userCalendarConnections)
        .set({ isPrimary: false })
        .where(eq(userCalendarConnections.userId, userId));
      await tx
        .update(userCalendarConnections)
        .set({ isPrimary: true })
        .where(eq(userCalendarConnections.id, connectionId));
    });

    return true;
  }

  async getFreeBusy(userId: string, timeMin: Date, timeMax: Date): Promise<BusySlot[]> {
    const connections = await this.db
      .select()
      .from(userCalendarConnections)
      .where(eq(userCalendarConnections.userId, userId));

    const busy: BusySlot[] = [];
    for (const conn of connections) {
      const token = await this.getValidToken(conn);
      if (!token) continue;
      try {
        const slots = await this.fetchProviderBusy(conn.provider, token, timeMin, timeMax);
        busy.push(...slots);
      } catch {
        continue;
      }
    }

    return busy;
  }

  async createEvent(userId: string, payload: CreateEventInput): Promise<void> {
    const connections = await this.db
      .select()
      .from(userCalendarConnections)
      .where(eq(userCalendarConnections.userId, userId))
      .orderBy(desc(userCalendarConnections.isPrimary), userCalendarConnections.id);

    const connection = connections.find((c) => c.isPrimary) ?? connections[0];
    if (!connection) return;

    const token = await this.getValidToken(connection);
    if (!token) return;

    try {
      await this.pushProviderEvent(connection.provider, token, payload);
    } catch {
      return;
    }
  }

  private async getValidToken(conn: ConnectionRow): Promise<string | null> {
    const isExpired = conn.expiresAt && conn.expiresAt < new Date();
    if (!isExpired) return conn.accessToken;
    if (!conn.refreshToken) return null;

    try {
      const tokens =
        conn.provider === "GOOGLE"
          ? await this.refreshGoogleToken(conn.refreshToken)
          : await this.refreshMicrosoftToken(conn.refreshToken);

      const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : undefined;

      await this.db
        .update(userCalendarConnections)
        .set({
          accessToken: tokens.access_token,
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          ...(expiresAt ? { expiresAt } : {}),
        })
        .where(eq(userCalendarConnections.id, conn.id));

      return tokens.access_token;
    } catch {
      return null;
    }
  }

  private async refreshGoogleToken(refreshToken: string): Promise<TokenResponse> {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CALENDAR_CLIENT_ID ?? "",
        client_secret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? "",
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error("Failed to refresh Google token");
    return res.json() as Promise<TokenResponse>;
  }

  private async refreshMicrosoftToken(refreshToken: string): Promise<TokenResponse> {
    const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.MICROSOFT_CALENDAR_CLIENT_ID ?? "",
        client_secret: process.env.MICROSOFT_CALENDAR_CLIENT_SECRET ?? "",
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: "https://graph.microsoft.com/Calendars.ReadWrite offline_access",
      }),
    });
    if (!res.ok) throw new Error("Failed to refresh Microsoft token");
    return res.json() as Promise<TokenResponse>;
  }

  private async fetchProviderBusy(
    provider: CalendarProvider,
    token: string,
    timeMin: Date,
    timeMax: Date,
  ): Promise<BusySlot[]> {
    if (provider === "GOOGLE") {
      const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          items: [{ id: "primary" }],
        }),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { calendars: Record<string, { busy: BusySlot[] }> };
      return data.calendars?.primary?.busy ?? [];
    }

    const res = await fetch("https://graph.microsoft.com/v1.0/me/calendarView/delta", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: `outlook.timezone="UTC"`,
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      value: { start: { dateTime: string }; end: { dateTime: string } }[];
    };
    return (data.value ?? []).map((e) => ({ start: e.start.dateTime, end: e.end.dateTime }));
  }

  private async pushProviderEvent(
    provider: CalendarProvider,
    token: string,
    payload: CreateEventInput,
  ): Promise<void> {
    if (provider === "GOOGLE") {
      await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: payload.summary,
          description: [payload.description, payload.conferenceLink].filter(Boolean).join("\n\n"),
          location: payload.location,
          start: { dateTime: payload.startDateTime, timeZone: "UTC" },
          end: { dateTime: payload.endDateTime, timeZone: "UTC" },
          attendees: payload.attendeeEmails.map((email) => ({ email })),
          sendNotifications: true,
        }),
      });
      return;
    }

    await fetch("https://graph.microsoft.com/v1.0/me/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: payload.summary,
        body: {
          contentType: "text",
          content: [payload.description, payload.conferenceLink].filter(Boolean).join("\n\n"),
        },
        location: { displayName: payload.location ?? "" },
        start: { dateTime: payload.startDateTime, timeZone: "UTC" },
        end: { dateTime: payload.endDateTime, timeZone: "UTC" },
        attendees: payload.attendeeEmails.map((email) => ({
          emailAddress: { address: email },
          type: "required",
        })),
        isOnlineMeeting: Boolean(payload.conferenceLink),
      }),
    });
  }
}
