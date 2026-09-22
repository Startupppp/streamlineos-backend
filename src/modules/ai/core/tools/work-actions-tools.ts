import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { and, eq, ilike, isNull } from "drizzle-orm";
import { cycles, tickets } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import { resolveAnyMailConnection } from "./lib/mail-connection";
import { resolvePeopleByName } from "../../../directory/person-seam";
import { businessParties, leadPartyMap } from "../../../../db/schema/party";
import { LEAD_PARTY_COLUMNS, LEAD_PARTY_JOIN, leadIdIs } from "../../../leads/lead-party-reader";
import { ticketScope } from "../../../build/core/tickets-scope";
import {
  defineTool,
  ambiguous,
  empty,
  needsConfirmation,
  needsConnection,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "../registry/ask-os-tool.types";
import { AskOsTools } from "../registry/ask-os-tools.decorator";

@AskOsTools()
@Injectable()
export class WorkActionsTools implements AskOsToolProvider {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly confirmation: AiConfirmationService,
  ) {}

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "createLead",
        description: "Create a new CRM lead.",
        input: z.object({
          name: z.string().min(1).max(200).describe("Lead's full name"),
          email: z.string().email().optional().describe("Lead email address"),
          phone: z.string().max(50).optional().describe("Lead phone number"),
          company: z.string().max(200).optional().describe("Lead company name"),
          notes: z.string().max(2000).optional().describe("Initial notes about the lead"),
        }),
        confirms: "crm.createLead",
        module: "crm",
        run: async ({ name, email, phone, company, notes }, ctx) => {
          const { orgId, userId } = ctx.actor;
          const payload: Record<string, unknown> = { name };
          if (email !== undefined) payload.email = email;
          if (phone !== undefined) payload.phone = phone;
          if (company !== undefined) payload.company = company;
          if (notes !== undefined) payload.notes = notes;

          const proposal = await this.confirmation.propose({ orgId, userId, action: "crm.createLead", payload });
          return needsConfirmation({
            proposalId: proposal.proposalId,
            token: proposal.token,
            expiresAt: proposal.expiresAt,
            action: "crm.createLead",
            summary: `Create lead: ${name}${company !== undefined ? ` at ${company}` : ""}`,
            preview: payload,
          });
        },
      }),

      defineTool({
        key: "logCrmActivity",
        description: "Log a CRM activity (call, email, meeting, note, task) on a lead.",
        input: z.object({
          leadIdentifier: z.string().min(1).describe("Lead name, email, or numeric ID string"),
          type: z.enum(["call", "email", "meeting", "note", "task"]).describe("Activity type"),
          notes: z.string().min(1).max(5000).describe("Activity notes or summary"),
          dueDate: z.string().optional().describe("Optional due date (ISO 8601)"),
        }),
        confirms: "crm.logActivity",
        module: "crm",
        run: async ({ leadIdentifier, type, notes, dueDate }, ctx) => {
          const { orgId, userId } = ctx.actor;

          const isNumeric = /^\d+$/.test(leadIdentifier.trim());
          const matches = await ctx.read.read(
            {
              tenant: leadPartyMap.organizationId,
              scope: { own: eq(businessParties.ownerUserId, userId) },
              and: [
                isNull(businessParties.deletedAt),
                isNumeric
                  ? leadIdIs(Number(leadIdentifier.trim()))
                  : ilike(LEAD_PARTY_COLUMNS.name, `%${leadIdentifier.trim()}%`),
              ],
            },
            ({ sql: where }) =>
              this.db
                .select({ id: LEAD_PARTY_COLUMNS.id, name: LEAD_PARTY_COLUMNS.name })
                .from(leadPartyMap)
                .innerJoin(businessParties, LEAD_PARTY_JOIN)
                .where(where)
                .limit(5),
            () => [],
          );

          if (matches.length === 0) return empty("lead", `No lead matches "${leadIdentifier}".`);
          if (matches.length > 1) {
            return empty(
              "lead",
              `"${leadIdentifier}" matches ${matches.length} leads: ${matches.map((m) => m.name).join(", ")}. Ask which one.`,
            );
          }

          const lead = matches[0];
          if (!lead) return empty("lead", `No lead matches "${leadIdentifier}".`);

          const payload: Record<string, unknown> = { leadIdentifier: lead.id, leadName: lead.name, type, notes };
          if (dueDate !== undefined) payload.dueDate = dueDate;

          const proposal = await this.confirmation.propose({ orgId, userId, action: "crm.logActivity", payload });
          return needsConfirmation({
            proposalId: proposal.proposalId,
            token: proposal.token,
            expiresAt: proposal.expiresAt,
            action: "crm.logActivity",
            summary: `Log ${type} on lead: ${lead.name}`,
            preview: payload,
          });
        },
      }),

      defineTool({
        key: "assignTicket",
        description:
          "Assign a ticket to a team member by name. Returns a confirmation card on a unique match. Returns empty if no member matches; reports ambiguity when multiple members match.",
        input: z.object({
          ticketId: z.number().int().positive().describe("Numeric ticket ID"),
          assigneeName: z.string().min(1).describe("Display name (or partial) of the member to assign"),
        }),
        confirms: "ticket.assign",
        module: "build",
        run: async ({ ticketId, assigneeName }, ctx) => {
          const { orgId, userId } = ctx.actor;

          const ticketRows = await ctx.read.read(
            {
              tenant: tickets.orgId,
              scope: ticketScope(orgId, userId),
              and: [eq(tickets.id, ticketId), isNull(tickets.deletedAt)],
            },
            ({ sql: where }) =>
              this.db
                .select({ id: tickets.id, title: tickets.title })
                .from(tickets)
                .where(where)
                .limit(1),
            () => [],
          );

          const [ticket] = ticketRows;
          if (!ticket) return empty("ticket", "Ticket not found in this org.");

          const resolutions = await resolvePeopleByName(this.db, orgId, [assigneeName]);
          const resolution = resolutions.get(assigneeName.trim());

          if (!resolution || resolution.status === "unresolved")
            return empty("member", `No active member found matching "${assigneeName}".`);

          if (resolution.status === "ambiguous") {
            return ambiguous(
              `"${assigneeName}" matches ${resolution.candidates.length} members. Which did you mean?`,
              [...resolution.candidates],
            );
          }

          const resolvedName = resolution.displayName ?? assigneeName;
          const ticketTitle = ticket.title;
          const payload: Record<string, unknown> = { ticketId, assigneeId: resolution.userId, assigneeName: resolvedName };

          const proposal = await this.confirmation.propose({ orgId, userId, action: "ticket.assign", payload });
          return needsConfirmation({
            proposalId: proposal.proposalId,
            token: proposal.token,
            expiresAt: proposal.expiresAt,
            action: "ticket.assign",
            summary: `Assign ticket #${ticketId} to ${resolvedName}`,
            preview: { ticketId, ticketTitle, assigneeName: resolvedName },
          });
        },
      }),

      defineTool({
        key: "moveToCycle",
        description: "Move a ticket into a cycle by cycle name.",
        input: z.object({
          ticketId: z.number().int().positive().describe("Numeric ticket ID"),
          cycleName: z.string().min(1).describe("Name (or partial) of the cycle to move the ticket into"),
        }),
        confirms: "ticket.moveToCycle",
        module: "build",
        run: async ({ ticketId, cycleName }, ctx) => {
          const { orgId, userId } = ctx.actor;

          const ticketRows = await ctx.read.read(
            {
              tenant: tickets.orgId,
              scope: ticketScope(orgId, userId),
              and: [eq(tickets.id, ticketId), isNull(tickets.deletedAt)],
            },
            ({ sql: where }) =>
              this.db
                .select({ id: tickets.id, title: tickets.title })
                .from(tickets)
                .where(where)
                .limit(1),
            () => [],
          );

          if (!ticketRows[0]) return empty("ticket", "Ticket not found in this org.");

          const cycleRows = await this.db
            .select({ id: cycles.id, name: cycles.name })
            .from(cycles)
            .where(and(eq(cycles.orgId, orgId), ilike(cycles.name, `%${cycleName}%`)))
            .limit(11);

          if (cycleRows.length === 0) return empty("cycle", `No cycle found matching "${cycleName}".`);

          if (cycleRows.length > 10)
            return empty("cycle", `"${cycleName}" matches too many cycles. Provide a more specific name.`);

          if (cycleRows.length > 1) {
            return ambiguous(
              `"${cycleName}" matches ${cycleRows.length} cycles. Which did you mean?`,
              cycleRows.map((c) => ({ label: c.name })),
            );
          }

          const cycle = cycleRows[0]!;
          const ticketTitle = ticketRows[0].title;
          const payload: Record<string, unknown> = { ticketId, cycleId: cycle.id, cycleName: cycle.name };

          const proposal = await this.confirmation.propose({ orgId, userId, action: "ticket.moveToCycle", payload });
          return needsConfirmation({
            proposalId: proposal.proposalId,
            token: proposal.token,
            expiresAt: proposal.expiresAt,
            action: "ticket.moveToCycle",
            summary: `Move ticket #${ticketId} to cycle "${cycle.name}"`,
            preview: { ticketId, ticketTitle, cycleId: cycle.id, cycleName: cycle.name },
          });
        },
      }),

      defineTool({
        key: "createCalendarEvent",
        description: "Create a calendar event.",
        input: z.object({
          title: z.string().min(1).max(200).describe("Event title"),
          startDate: z.string().describe("ISO 8601 start datetime"),
          endDate: z.string().describe("ISO 8601 end datetime"),
          attendeeNames: z.array(z.string()).max(50).optional().describe("Optional attendee names"),
          location: z.string().max(500).optional().describe("Optional location"),
          description: z.string().max(5000).optional().describe("Optional event description"),
        }),
        confirms: "calendar.createEvent",
        module: "calendar",
        run: async ({ title, startDate, endDate, attendeeNames, location, description }, ctx) => {
          const { orgId, userId, timezone } = ctx.actor;
          const payload: Record<string, unknown> = { title, startDate, endDate, timezone };
          if (attendeeNames !== undefined && attendeeNames.length > 0) payload.attendeeNames = attendeeNames;
          if (location !== undefined) payload.location = location;
          if (description !== undefined) payload.description = description;

          const proposal = await this.confirmation.propose({ orgId, userId, action: "calendar.createEvent", payload });
          return needsConfirmation({
            proposalId: proposal.proposalId,
            token: proposal.token,
            expiresAt: proposal.expiresAt,
            action: "calendar.createEvent",
            summary: `Create event: ${title}`,
            preview: payload,
          });
        },
      }),

      defineTool({
        key: "replyToMailThread",
        description:
          "Reply to an email thread from the user's connected mail account. Requires a connected mail account.",
        input: z.object({
          threadId: z.string().min(1).describe("The thread ID to reply to"),
          body: z.string().min(1).max(10000).describe("Reply body text"),
          accountEmail: z.string().email().optional().describe("The connected email account to reply from (uses primary if omitted)"),
        }),
        confirms: "mail.reply",
        module: "mail",
        run: async ({ threadId, body, accountEmail }, ctx) => {
          const { orgId, userId, membershipId } = ctx.actor;
          const connection = await resolveAnyMailConnection(this.db, { orgId, userId, membershipId });
          if (!connection.connected) {
            return needsConnection(connection.toolkit, connection.reason, "Connect a mail account to reply to threads.");
          }

          const payload: Record<string, unknown> = { threadId, body };
          if (accountEmail !== undefined) payload.accountEmail = accountEmail;

          const proposal = await this.confirmation.propose({ orgId, userId, action: "mail.reply", payload });
          return needsConfirmation({
            proposalId: proposal.proposalId,
            token: proposal.token,
            expiresAt: proposal.expiresAt,
            action: "mail.reply",
            summary: `Reply to thread ${threadId}`,
            preview: {
              threadId,
              bodyPreview: body.length > 100 ? `${body.slice(0, 100)}…` : body,
              accountEmail: accountEmail ?? "primary",
            },
          });
        },
      }),
    ];
  }
}
