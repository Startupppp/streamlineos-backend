import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { and, asc, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { tasks } from "../../../db/schema";
import { businessParties, leadPartyMap } from "../../../db/schema/party";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { updateMirroredLeads } from "../../party/party-legacy-leads";
import { LEAD_PARTY_COLUMNS, LEAD_PARTY_JOIN, leadIdIs } from "../../leads/lead-party-reader";
import {
  defineTool,
  data,
  empty,
  failed,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "./registry/ask-os-tool.types";

@Injectable()
export class CrmCopilotTools implements AskOsToolProvider {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "updateLeadStatus",
        description:
          "Update the status or priority of a lead by name or ID. Use when the user asks to move, update, or change a lead's status/priority.",
        input: z.object({
          leadIdentifier: z.string().describe("Lead name (partial) or numeric ID"),
          status: z.string().optional(),
          priority: z.string().optional(),
        }),
        permission: "crm:leads:update",
        module: "crm",
        run: async ({ leadIdentifier, status, priority }, ctx) => {
          const { orgId, userId } = ctx.actor;
          const scopePredicate =
            ctx.scope === "own" || ctx.scope === "team"
              ? eq(businessParties.ownerUserId, userId)
              : sql`true`;
          const isNumeric = /^\d+$/.test(leadIdentifier.trim());
          const domain = and(
            eq(leadPartyMap.organizationId, orgId),
            isNull(businessParties.deletedAt),
            scopePredicate,
            isNumeric ? leadIdIs(Number(leadIdentifier)) : ilike(LEAD_PARTY_COLUMNS.name, `%${leadIdentifier}%`),
          );

          const [row] = await this.db
            .select({
              id: LEAD_PARTY_COLUMNS.id,
              name: LEAD_PARTY_COLUMNS.name,
              status: LEAD_PARTY_COLUMNS.status,
              priority: LEAD_PARTY_COLUMNS.priority,
            })
            .from(leadPartyMap)
            .innerJoin(businessParties, LEAD_PARTY_JOIN)
            .where(domain)
            .orderBy(asc(LEAD_PARTY_COLUMNS.id))
            .limit(1);

          if (!row) return empty("lead", `No lead found matching "${leadIdentifier}".`);

          const updateData: Partial<{ status: string; priority: string }> = {};
          if (status) updateData.status = status;
          if (priority) updateData.priority = priority;
          if (Object.keys(updateData).length === 0) return failed("No status or priority provided to update.");

          await updateMirroredLeads(this.db, orgId, [row.id], updateData);
          return data({ leadId: row.id, name: row.name, updated: updateData });
        },
      }),

      defineTool({
        key: "createTask",
        description:
          "Create a new task for the user. Use when the user asks to create, add, or remind about a task.",
        input: z.object({
          title: z.string().min(1).max(200).describe("Task title"),
          notes: z.string().optional().describe("Additional notes"),
          type: z.enum(["CALL", "EMAIL", "MEETING", "CUSTOM"]).default("CUSTOM"),
          dueDate: z.string().optional().describe("ISO date string for due date, e.g. 2026-04-15"),
        }),
        permission: "tasks:write",
        module: "tasks",
        run: async ({ title, notes, type, dueDate }, ctx) => {
          const { orgId, userId } = ctx.actor;
          await this.db.insert(tasks).values({
            orgId,
            title,
            notes: notes ?? null,
            type,
            status: "pending",
            assigneeId: userId,
            createdBy: userId,
            dueDate: dueDate ? new Date(dueDate) : null,
          });
          return data({ title, created: true });
        },
      }),

      defineTool({
        key: "searchLeads",
        description:
          "Search for leads by name, company, or status to answer user questions about their pipeline.",
        input: z.object({
          query: z.string().describe("Name, company, or partial match to search"),
          status: z.enum(["NEW", "CONTACTED", "INTERESTED", "QUALIFIED", "CONVERTED", "LOST"]).optional(),
          limit: z.number().int().min(1).max(10).default(5),
        }),
        permission: "crm:leads:view",
        module: "crm",
        run: async ({ query, status, limit }, ctx) => {
          const { orgId, userId } = ctx.actor;
          const scopePredicate =
            ctx.scope === "own" || ctx.scope === "team"
              ? eq(businessParties.ownerUserId, userId)
              : sql`true`;
          const domain = and(
            eq(leadPartyMap.organizationId, orgId),
            isNull(businessParties.deletedAt),
            scopePredicate,
            ilike(LEAD_PARTY_COLUMNS.name, `%${query}%`),
            status ? eq(LEAD_PARTY_COLUMNS.status, status) : undefined,
          );

          const results = await this.db
            .select({
              id: LEAD_PARTY_COLUMNS.id,
              name: LEAD_PARTY_COLUMNS.name,
              status: LEAD_PARTY_COLUMNS.status,
              priority: LEAD_PARTY_COLUMNS.priority,
              company: LEAD_PARTY_COLUMNS.company,
              potentialValue: LEAD_PARTY_COLUMNS.potentialValue,
            })
            .from(leadPartyMap)
            .innerJoin(businessParties, LEAD_PARTY_JOIN)
            .where(domain)
            .orderBy(desc(LEAD_PARTY_COLUMNS.createdAt), desc(LEAD_PARTY_COLUMNS.id))
            .limit(limit);

          if (results.length === 0) return empty("leads", `No leads found matching "${query}".`);
          return data({ results, count: results.length });
        },
      }),
    ];
  }
}
