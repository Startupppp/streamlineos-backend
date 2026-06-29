import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { interviews, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { APP_CONFIG } from "../../config/config.module";
import { type AppConfig } from "../../config/env.validation";
import { appUrl } from "../email/app-url";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MEET_EVENTS_URL = `${EVENTS_URL}?conferenceDataVersion=1`;

const tokenSchema = z.object({ access_token: z.string() });

const meetEventSchema = z.object({
  conferenceData: z
    .object({
      entryPoints: z
        .array(z.object({ uri: z.string().optional(), entryPointType: z.string() }))
        .optional(),
    })
    .optional(),
});

const syncEventSchema = z.object({ id: z.string(), htmlLink: z.string() });

export interface InterviewEventPayload {
  summary: string;
  description: string;
  start: Date;
  end: Date;
  meetingLink?: string | null;
}

@Injectable()
export class GoogleCalendarService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async getStatus(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { googleRefreshToken: true, googleEmail: true },
    });
    return {
      connected: !!user?.googleRefreshToken,
      googleEmail: user?.googleEmail ?? null,
      authUrl: `${appUrl}/api/integrations/google/auth`,
    };
  }

  async createMeet(userId: string) {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      throw new ServiceUnavailableException("Google Meet integration not configured");
    }

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { googleRefreshToken: true },
    });

    if (!user?.googleRefreshToken) {
      throw new UnauthorizedException(
        "Google account not connected. Please connect your Google account first.",
      );
    }

    try {
      const accessToken = await this.getAccessToken(user.googleRefreshToken);
      const now = new Date();
      const later = new Date(now.getTime() + 3600 * 1000);

      const calRes = await fetch(MEET_EVENTS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary: "Meeting",
          start: { dateTime: now.toISOString() },
          end: { dateTime: later.toISOString() },
          conferenceData: {
            createRequest: {
              requestId: `meet-${Date.now()}`,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }),
      });

      if (!calRes.ok) throw new Error("Google Calendar API error");
      const calEvent = meetEventSchema.parse(await calRes.json());

      const meetLink = calEvent.conferenceData?.entryPoints?.find(
        (ep) => ep.entryPointType === "video",
      )?.uri;

      if (!meetLink) throw new Error("No Meet link in response");
      return { meetLink };
    } catch (e) {
      throw new InternalServerErrorException(
        e instanceof Error ? e.message : "Failed to create Meet link",
      );
    }
  }

  async syncInterview(orgId: string, userId: string, interviewId: number) {
    const interview = await this.db.query.interviews.findFirst({
      where: and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)),
      with: { candidate: true },
    });
    if (!interview) throw new NotFoundException("Interview not found.");

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { googleRefreshToken: true, googleEmail: true },
    });
    if (!user?.googleRefreshToken) {
      throw new BadRequestException(
        "Google Calendar not connected. Connect via Settings → Integrations.",
      );
    }

    const candidateName = interview.candidate
      ? `${interview.candidate.firstName} ${interview.candidate.lastName}`
      : "Candidate";

    const startTime = new Date(interview.scheduledAt);
    const endTime = new Date(startTime.getTime() + (interview.duration ?? 60) * 60000);

    try {
      const tokenResponse = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID ?? "",
          client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
          refresh_token: user.googleRefreshToken,
          grant_type: "refresh_token",
        }),
      });

      if (!tokenResponse.ok) {
        throw new BadRequestException("Failed to refresh Google token. Please reconnect.");
      }
      const { access_token } = tokenSchema.parse(await tokenResponse.json());

      const calendarResponse = await fetch(EVENTS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary: `Interview: ${candidateName} - ${interview.type}`,
          description: `${interview.type} interview with ${candidateName}\n${interview.notes ?? ""}`,
          start: { dateTime: startTime.toISOString() },
          end: { dateTime: endTime.toISOString() },
          ...(interview.meetingLink && {
            conferenceData: {
              entryPoints: [{ entryPointType: "video", uri: interview.meetingLink }],
            },
          }),
        }),
      });

      if (!calendarResponse.ok) {
        const errorData = await calendarResponse.text();
        throw new BadGatewayException(`Google Calendar error: ${errorData.slice(0, 200)}`);
      }

      const event = syncEventSchema.parse(await calendarResponse.json());
      return { eventId: event.id, link: event.htmlLink };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new BadGatewayException("Failed to sync with Google Calendar.");
    }
  }

  async pushInterviewEvent(userId: string, payload: InterviewEventPayload): Promise<void> {
    try {
      const user = await this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { googleRefreshToken: true },
      });
      if (!user?.googleRefreshToken) return;

      const tokenRes = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID ?? "",
          client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
          refresh_token: user.googleRefreshToken,
          grant_type: "refresh_token",
        }),
      });
      if (!tokenRes.ok) return;
      const { access_token } = tokenSchema.parse(await tokenRes.json());

      await fetch(EVENTS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary: payload.summary,
          description: payload.description,
          start: { dateTime: payload.start.toISOString() },
          end: { dateTime: payload.end.toISOString() },
          ...(payload.meetingLink && {
            conferenceData: {
              entryPoints: [{ entryPointType: "video", uri: payload.meetingLink }],
            },
          }),
        }),
      });
    } catch {
      return;
    }
  }

  private async getAccessToken(refreshToken: string): Promise<string> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID ?? "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error("Failed to refresh Google token");
    const data = tokenSchema.parse(await res.json());
    return data.access_token;
  }
}
