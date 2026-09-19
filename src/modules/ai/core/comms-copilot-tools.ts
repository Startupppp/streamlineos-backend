import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { organizationMembers, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AiConfirmationService } from "../confirmation/ai-confirmation.service";
import { displayNameFrom } from "./services/ask-os-actor";
import {
  defineTool,
  data,
  empty,
  needsConfirmation,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "./registry/ask-os-tool.types";

export const MIN_NAME_MATCH_CHARS = 2;
export const MEMBER_SCAN_CAP = 500;

interface ResolvedAttendees {
  resolved: string[];
  unresolved: string[];
  ambiguous: string[];
}

@Injectable()
export class CommsCopilotTools implements AskOsToolProvider {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly confirmation: AiConfirmationService,
  ) {}

  private async resolveMemberName(orgId: string, userId: string): Promise<string> {
    const rows = await this.db
      .select({
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    const row = rows[0];
    return row ? displayNameFrom(row) : userId;
  }

  private async resolveAttendeeIds(orgId: string, names: string[]): Promise<ResolvedAttendees> {
    const needles = names
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length >= MIN_NAME_MATCH_CHARS);
    if (needles.length === 0)
      return { resolved: [], unresolved: names.map((name) => name.trim()).filter(Boolean), ambiguous: [] };

    const rows = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        name: users.name,
        email: users.email,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.status, "ACTIVE"),
          eq(users.isActive, true),
          isNull(users.deletedAt),
        ),
      )
      .limit(MEMBER_SCAN_CAP);

    const resolved: string[] = [];
    const unresolved: string[] = [];
    const ambiguous: string[] = [];

    for (const needle of needles) {
      const matches = rows.filter((row) =>
        displayNameFrom(row).toLowerCase().includes(needle),
      );
      if (matches.length === 0) {
        unresolved.push(needle);
        continue;
      }
      const only = matches[0];
      if (matches.length > 1 || !only) {
        ambiguous.push(needle);
        continue;
      }
      resolved.push(only.id);
    }

    return { resolved, unresolved, ambiguous };
  }

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
        permission: "calendar:write",
        module: "calendar",
        run: async ({ title, startDate, endDate, attendeeNames, location, description }, ctx) => {
          const { orgId, userId, timezone } = ctx.actor;
          const { resolved, unresolved, ambiguous } = await this.resolveAttendeeIds(orgId, attendeeNames ?? []);

          if (ambiguous.length > 0)
            return data({
              ambiguous: true,
              reason: `"${ambiguous.join('", "')}" matches more than one member. Ask which was meant.`,
            });

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
          recipientName: z.string().describe("The name (or partial name) of the team member to message"),
          message: z.string().min(1).max(5000).describe("The message content to send"),
        }),
        permission: "chat:messages:write",
        module: "chat",
        run: async ({ recipientName, message }, ctx) => {
          const { orgId, userId } = ctx.actor;
          const { resolved, unresolved, ambiguous } = await this.resolveAttendeeIds(orgId, [recipientName]);

          if (ambiguous.length > 0)
            return data({
              ambiguous: true,
              reason: `"${recipientName}" matches more than one member. Ask which was meant.`,
            });

          if (unresolved.length > 0) return empty("recipient", `No member found matching "${recipientName}".`);

          const targetUserId = resolved[0];
          if (targetUserId === undefined)
            return empty("recipient", `No member found matching "${recipientName}".`);

          const recipient = await this.resolveMemberName(orgId, targetUserId);

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
            summary: `Send a direct message to ${recipient}`,
            preview: { recipient, message },
          });
        },
      }),
    ];
  }
}
