import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { ComposioGateway } from "../integrations/composio.gateway";
import { TOOL_SLUGS } from "./external-event-normalizers";

export interface PushEventInput {
  title: string;
  description: string | null;
  startIso: string;
  endIso: string;
  allDay: boolean;
  attendeeEmails: string[];
  addConference: boolean;
}

export interface PushConnection {
  id: number;
  toolkit: "googlecalendar" | "outlook";
  composioConnectedAccountId: string;
}

export interface PushCreateResult {
  externalEventId: string;
  meetingUrl: string | null;
}

const googleCreateResponseSchema = z
  .object({ id: z.string().optional(), hangoutLink: z.string().optional() })
  .passthrough();

const outlookCreateResponseSchema = z
  .object({
    id: z.string().optional(),
    onlineMeeting: z
      .object({ joinUrl: z.string().optional() })
      .nullable()
      .optional(),
  })
  .passthrough();

function unwrap(data: unknown): unknown {
  if (data !== null && typeof data === "object" && "response_data" in data) {
    return (data as Record<string, unknown>).response_data;
  }
  return data;
}

@Injectable()
export class ExternalCalendarSyncService {
  constructor(private readonly gateway: ComposioGateway) {}

  async pushCreate(
    userId: string,
    conn: PushConnection,
    input: PushEventInput,
  ): Promise<PushCreateResult> {
    if (conn.toolkit === "googlecalendar") {
      const data = unwrap(
        await this.gateway.executeTool(
          TOOL_SLUGS.googleCreate,
          userId,
          {
            summary: input.title,
            description: input.description ?? undefined,
            start_datetime: input.startIso,
            end_datetime: input.endIso,
            create_meeting_room: input.addConference,
            attendees:
              input.attendeeEmails.length > 0
                ? input.attendeeEmails
                : undefined,
          },
          conn.composioConnectedAccountId,
        ),
      );
      const parsed = googleCreateResponseSchema.parse(data);
      if (!parsed.id)
        throw new Error("Google Calendar did not return an event id");
      return {
        externalEventId: parsed.id,
        meetingUrl: parsed.hangoutLink ?? null,
      };
    }
    const data = unwrap(
      await this.gateway.executeTool(
        TOOL_SLUGS.outlookCreate,
        userId,
        {
          subject: input.title,
          body: input.description ?? undefined,
          start: { dateTime: input.startIso, timeZone: "UTC" },
          end: { dateTime: input.endIso, timeZone: "UTC" },
          is_online_meeting: input.addConference,
          online_meeting_provider: input.addConference
            ? "teamsForBusiness"
            : undefined,
          attendees:
            input.attendeeEmails.length > 0
              ? input.attendeeEmails.map((email) => ({
                  emailAddress: { address: email },
                  type: "required",
                }))
              : undefined,
        },
        conn.composioConnectedAccountId,
      ),
    );
    const parsed = outlookCreateResponseSchema.parse(data);
    if (!parsed.id) throw new Error("Outlook did not return an event id");
    return {
      externalEventId: parsed.id,
      meetingUrl: parsed.onlineMeeting?.joinUrl ?? null,
    };
  }

  async pushUpdate(
    userId: string,
    conn: PushConnection,
    externalEventId: string,
    input: Pick<
      PushEventInput,
      "title" | "description" | "startIso" | "endIso"
    >,
  ): Promise<void> {
    if (conn.toolkit === "googlecalendar") {
      await this.gateway.executeTool(
        TOOL_SLUGS.googleUpdate,
        userId,
        {
          event_id: externalEventId,
          summary: input.title,
          description: input.description ?? undefined,
          start_datetime: input.startIso,
          end_datetime: input.endIso,
        },
        conn.composioConnectedAccountId,
      );
    }
  }

  async pushDelete(
    userId: string,
    conn: PushConnection,
    externalEventId: string,
  ): Promise<void> {
    if (conn.toolkit === "googlecalendar") {
      await this.gateway.executeTool(
        TOOL_SLUGS.googleDelete,
        userId,
        { event_id: externalEventId },
        conn.composioConnectedAccountId,
      );
    }
  }
}
