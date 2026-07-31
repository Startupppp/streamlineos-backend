import { Inject, Injectable } from "@nestjs/common";
import { tool } from "ai";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { organizationMembers, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { ToolAccessService } from "./tool-access.service";
import { CalendarService } from "../../calendar/calendar.service";
import { ChatChannelsService } from "../../chat/chat-channels.service";
import { ChatMessagesService } from "../../chat/chat-messages.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

export interface CommsCopilotContext {
  actor: CurrentUserContext;
}

@Injectable()
export class CommsCopilotTools {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly toolAccess: ToolAccessService,
    private readonly calendar: CalendarService,
    private readonly chatChannels: ChatChannelsService,
    private readonly chatMessages: ChatMessagesService,
  ) {}

  private async resolveAttendeeIds(orgId: string, names: string[]): Promise<{ resolved: string[]; unresolved: string[] }> {
    if (names.length === 0) return { resolved: [], unresolved: [] };

    const rows = await this.db
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, name: users.name })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)));

    const resolved: string[] = [];
    const unresolved: string[] = [];

    for (const name of names) {
      const lower = name.toLowerCase();
      const match = rows.find((r) => {
        const full = `${r.firstName ?? ""} ${r.lastName ?? ""}`.toLowerCase().trim();
        const display = (r.name ?? "").toLowerCase();
        return full.includes(lower) || display.includes(lower) || lower.includes((r.firstName ?? "").toLowerCase());
      });
      if (match) {
        resolved.push(match.id);
      } else {
        unresolved.push(name);
      }
    }

    return { resolved, unresolved };
  }

  buildTools(ctx: CommsCopilotContext) {
    const { orgId, userId } = ctx.actor;

    return {
      scheduleEvent: tool({
        description:
          "Schedule a calendar event or meeting. Only call this after confirming the event title, date, time, and attendees with the user.",
        inputSchema: z.object({
          title: z.string().min(2).max(100).describe("Event title"),
          startDate: z.string().describe("ISO 8601 start datetime, e.g. 2026-07-10T10:00:00.000Z"),
          endDate: z.string().describe("ISO 8601 end datetime, e.g. 2026-07-10T11:00:00.000Z"),
          attendeeNames: z.array(z.string()).optional().describe("Names of org members to invite"),
          location: z.string().optional().describe("Event location or meeting link"),
          description: z.string().optional().describe("Event description or agenda"),
        }),
        execute: async ({ title, startDate, endDate, attendeeNames, location, description }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "calendar:write");
          if (deny) return { denied: true, reason: deny };

          const { resolved, unresolved } = await this.resolveAttendeeIds(orgId, attendeeNames ?? []);

          const { event } = await this.calendar.createEvent(orgId, userId, {
            title,
            startDate,
            endDate,
            attendeeIds: resolved,
            location,
            description,
            category: "meeting",
            color: "blue",
          });

          const start = new Date(startDate);
          const dateStr = start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
          const timeStr = `${start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} – ${new Date(endDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;

          const note = unresolved.length > 0
            ? ` Note: could not find org members matching: ${unresolved.join(", ")}.`
            : "";

          return {
            success: true,
            eventId: event?.id,
            message: `Event "${title}" scheduled for ${dateStr} at ${timeStr}${resolved.length > 0 ? ` with ${resolved.length} attendee(s)` : ""}.${note}`,
          };
        },
      }),

      sendDirectMessage: tool({
        description:
          "Send a direct message to a team member by name on the user's behalf. Only call this after confirming the recipient name and message content with the user.",
        inputSchema: z.object({
          recipientName: z.string().describe("The name (or partial name) of the team member to message"),
          message: z.string().min(1).max(5000).describe("The message content to send"),
        }),
        execute: async ({ recipientName, message }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "chat:messages:write");
          if (deny) return { denied: true, reason: deny };

          const { resolved, unresolved } = await this.resolveAttendeeIds(orgId, [recipientName]);

          if (unresolved.length > 0) {
            return {
              success: false,
              message: `Could not find a team member matching "${recipientName}". Please check the name and try again.`,
            };
          }

          const targetUserId = resolved[0];

          try {
            const { channel } = await this.chatChannels.createChannel(orgId, userId, {
              type: "DIRECT",
              targetUserId,
            });

            await this.chatMessages.send(channel.id, userId, orgId, { content: message });

            return {
              success: true,
              message: `Message sent to ${recipientName} successfully.`,
            };
          } catch {
            return {
              success: false,
              message: `Failed to send the message. Please try again later.`,
            };
          }
        },
      }),
    };
  }
}
