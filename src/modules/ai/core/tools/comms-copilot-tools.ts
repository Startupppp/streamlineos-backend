import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import {
  defineTool,
  ambiguous,
  empty,
  needsConfirmation,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "../registry/ask-os-tool.types";
import { AskOsTools } from "../registry/ask-os-tools.decorator";
import { resolveAttendeeNames } from "./lib/resolve-attendees";

@AskOsTools()
@Injectable()
export class CommsCopilotTools implements AskOsToolProvider {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly confirmation: AiConfirmationService,
  ) {}

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "scheduleEvent",
        description:
          "Schedule a calendar event or meeting. Only call this after confirming the event title, date, time, and attendees with the user.",
        input: z.object({
          title: z.string().min(2).max(100).describe("Event title"),
          startDate: z.string().describe("ISO 8601 start datetime, e.g. 2026-07-10T10:00:00.000Z"),
          endDate: z.string().describe("ISO 8601 end datetime, e.g. 2026-07-10T11:00:00.000Z"),
          attendeeNames: z.array(z.string()).optional().describe("Names of org members to invite"),
          location: z.string().optional().describe("Event location or meeting link"),
          description: z.string().optional().describe("Event description or agenda"),
        }),
        confirms: "calendar.scheduleMeeting",
        module: "calendar",
        run: async ({ title, startDate, endDate, attendeeNames, location, description }, ctx) => {
          const { orgId, userId, timezone } = ctx.actor;
          const { resolved, unresolved, firstAmbiguous } = await resolveAttendeeNames(
            this.db,
            orgId,
            attendeeNames ?? [],
          );

          if (firstAmbiguous !== null)
            return ambiguous(
              `"${firstAmbiguous.needle}" matches more than one member. Ask which was meant.`,
              firstAmbiguous.candidates,
            );

          const payload: Record<string, unknown> = {
            title,
            startDate,
            endDate,
            timezone,
            attendeeIds: resolved,
          };
          if (location !== undefined) payload.location = location;
          if (description !== undefined) payload.description = description;

          const proposal = await this.confirmation.propose({
            orgId,
            userId,
            action: "calendar.scheduleMeeting",
            payload,
          });

          const note =
            unresolved.length > 0 ? ` Could not match: ${unresolved.join(", ")}.` : "";

          return needsConfirmation({
            proposalId: proposal.proposalId,
            token: proposal.token,
            expiresAt: proposal.expiresAt,
            action: "calendar.scheduleMeeting",
            summary: `Schedule "${title}" with ${resolved.length} attendee(s).${note}`,
            preview: { title, startDate, endDate, timezone, attendees: resolved.length, location },
          });
        },
      }),

      defineTool({
        key: "sendDirectMessage",
        description:
          "Send a direct message to a team member by name on the user's behalf. Only call this after confirming the recipient name and message content with the user.",
        input: z.object({
          recipientName: z.string().describe("The name of the team member to message"),
          message: z.string().min(1).max(5000).describe("The message content to send"),
        }),
        confirms: "chat.sendDirect",
        module: "chat",
        run: async ({ recipientName, message }, ctx) => {
          const { orgId, userId } = ctx.actor;
          const { resolved, unresolved, firstAmbiguous } = await resolveAttendeeNames(
            this.db,
            orgId,
            [recipientName],
          );

          if (firstAmbiguous !== null)
            return ambiguous(
              `"${recipientName}" matches more than one member. Ask which was meant.`,
              firstAmbiguous.candidates,
            );

          if (unresolved.length > 0) return empty("recipient", `No member found matching "${recipientName}".`);

          const targetUserId = resolved[0];
          if (targetUserId === undefined)
            return empty("recipient", `No member found matching "${recipientName}".`);

          const proposal = await this.confirmation.propose({
            orgId,
            userId,
            action: "chat.sendDirect",
            payload: { targetUserId, message },
          });

          return needsConfirmation({
            proposalId: proposal.proposalId,
            token: proposal.token,
            expiresAt: proposal.expiresAt,
            action: "chat.sendDirect",
            summary: `Send a direct message to ${recipientName}`,
            preview: { recipient: recipientName, message },
          });
        },
      }),
    ];
  }
}
