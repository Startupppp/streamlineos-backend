import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { ComposioGateway } from "../integrations/core/composio.gateway";
import {
  PROVIDER_CAPABILITIES,
  ProviderCapabilityError,
  TOOL_SLUGS,
  googleInstanceEventId,
  unwrapComposioData,
} from "./external-event-normalizers";

export type MutationResult = { success: true } | { success: false; reason: string };

export interface PushEventInput {
  title: string;
  description: string | null;
  startIso: string;
  endIso: string;
  allDay: boolean;
  attendeeEmails: string[];
  addConference: boolean;
  /**
   * The series' RRULE, verbatim from `calendar_events.rrule`, or null/absent for a
   * one-off. Omitting it is what made every synced series land at the provider as a
   * single meeting; see `PROVIDER_CAPABILITIES.recurrence`.
   */
  rrule?: string | null;
}

/**
 * Names ONE occurrence of a series, so an exception is pushed as an instance write
 * instead of a whole-series overwrite.
 *
 * `nominalStart` is the instant the RRULE generated — the same value
 * `calendar_event_exceptions.occurrence_start` is keyed on — because that is the only
 * name for the occurrence that does not change when the occurrence is moved.
 */
export interface PushOccurrenceTarget {
  nominalStart: Date;
  allDay: boolean;
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

/**
 * `rrule` is stored the way the client authored it, which may or may not carry the
 * `RRULE:` content-line prefix Google's `recurrence` array requires. Normalising here
 * keeps both shapes working and keeps the DB free of a format migration.
 */
function toRecurrenceLines(rrule: string): string[] {
  return rrule
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (/^(RRULE|RDATE|EXRULE|EXDATE|DTSTART):/i.test(line) ? line : `RRULE:${line}`));
}

@Injectable()
export class ExternalCalendarSyncService {
  constructor(private readonly gateway: ComposioGateway) {}

  /**
   * Refuses a push the provider cannot represent, BEFORE it is sent.
   *
   * Every caller of this used to be a `logger.warn` in the sweep that fell through to
   * the PROCESSED mark, so `getSyncStatus` answered `synced` over a provider copy that
   * was never written. A throw is the point: the sweep turns it into a terminal FAILED
   * row carrying this reason.
   */
  private assertExpressible(
    toolkit: PushConnection["toolkit"],
    input: Pick<PushEventInput, "rrule">,
    occurrence: PushOccurrenceTarget | undefined,
  ): void {
    const capabilities = PROVIDER_CAPABILITIES[toolkit];
    if (input.rrule && !capabilities.recurrence)
      throw new ProviderCapabilityError(
        `${toolkit} cannot represent a recurring series through this integration, so the series would land as a single meeting`,
      );
    if (occurrence && !capabilities.occurrence)
      throw new ProviderCapabilityError(
        `${toolkit} cannot address a single occurrence of a series through this integration`,
      );
  }

  async pushCreate(
    userId: string,
    conn: PushConnection,
    input: PushEventInput,
  ): Promise<PushCreateResult> {
    this.assertExpressible(conn.toolkit, input, undefined);
    if (conn.toolkit === "googlecalendar") {
      const data = unwrapComposioData(
        await this.gateway.executeTool(
          TOOL_SLUGS.googleCreate,
          userId,
          {
            summary: input.title,
            description: input.description ?? undefined,
            start_datetime: input.startIso,
            end_datetime: input.endIso,
            create_meeting_room: input.addConference,
            recurrence: input.rrule ? toRecurrenceLines(input.rrule) : undefined,
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
    const data = unwrapComposioData(
      await this.gateway.executeTool(
        TOOL_SLUGS.outlookCreate,
        userId,
        {
          subject: input.title,
          body: input.description ?? undefined,
          start_datetime: input.startIso.slice(0, 19),
          end_datetime: input.endIso.slice(0, 19),
          time_zone: "UTC",
          is_online_meeting: input.addConference,
          online_meeting_provider: input.addConference
            ? "teamsForBusiness"
            : undefined,
          attendees_info:
            input.attendeeEmails.length > 0
              ? input.attendeeEmails.map((email) => ({ email }))
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
      "title" | "description" | "startIso" | "endIso" | "rrule"
    >,
    occurrence?: PushOccurrenceTarget,
  ): Promise<MutationResult> {
    if (!PROVIDER_CAPABILITIES[conn.toolkit].update) {
      return { success: false, reason: `${conn.toolkit} does not support event updates via this integration` };
    }
    this.assertExpressible(conn.toolkit, input, occurrence);
    const targetId = occurrence
      ? googleInstanceEventId(externalEventId, occurrence.nominalStart, occurrence.allDay)
      : externalEventId;
    await this.gateway.executeTool(
      TOOL_SLUGS.googleUpdate,
      userId,
      {
        event_id: targetId,
        summary: input.title,
        description: input.description ?? undefined,
        start_datetime: input.startIso,
        end_datetime: input.endIso,
        // An instance write must not carry the series' rule — that would rewrite the
        // whole series from the one occurrence being moved.
        recurrence: !occurrence && input.rrule ? toRecurrenceLines(input.rrule) : undefined,
      },
      conn.composioConnectedAccountId,
    );
    return { success: true };
  }

  async pushDelete(
    userId: string,
    conn: PushConnection,
    externalEventId: string,
    occurrence?: PushOccurrenceTarget,
  ): Promise<MutationResult> {
    if (!PROVIDER_CAPABILITIES[conn.toolkit].delete) {
      return { success: false, reason: `${conn.toolkit} does not support event deletion via this integration` };
    }
    this.assertExpressible(conn.toolkit, { rrule: null }, occurrence);
    const targetId = occurrence
      ? googleInstanceEventId(externalEventId, occurrence.nominalStart, occurrence.allDay)
      : externalEventId;
    await this.gateway.executeTool(
      TOOL_SLUGS.googleDelete,
      userId,
      { event_id: targetId },
      conn.composioConnectedAccountId,
    );
    return { success: true };
  }
}
