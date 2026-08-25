import { Inject, Injectable } from "@nestjs/common";
import { tool } from "ai";
import { z } from "zod";
import { and, asc, desc, eq, ilike } from "drizzle-orm";
import { tasks } from "../../../db/schema";
import { businessParties, leadPartyMap } from "../../../db/schema/party";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { ToolAccessService } from "./tool-access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { updateMirroredLeads } from "../../party/party-legacy-leads";
import {
  INCLUDE_DELETED,
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadIdIs,
  leadPartyScope,
} from "../../leads/lead-party-reader";

export interface CrmCopilotContext {
  actor: CurrentUserContext;
}

@Injectable()
export class CrmCopilotTools {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly toolAccess: ToolAccessService,
  ) {}

  buildTools(ctx: CrmCopilotContext) {
    const { orgId, userId } = ctx.actor;

    return {
      updateLeadStatus: tool({
        description:
          "Update the status or priority of a lead by name or ID. Use when the user asks to move, update, or change a lead's status/priority.",
        inputSchema: z.object({
          leadIdentifier: z.string().describe("Lead name (partial) or numeric ID"),
          status: z.string().optional(),
          priority: z.string().optional(),
        }),
        execute: async ({ leadIdentifier, status, priority }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "crm:leads:update");
          if (deny) return { denied: true, reason: deny };

          const isNumeric = /^\d+$/.test(leadIdentifier.trim());
          // Through `lead_party_map`, so the values are the party's rather than
          // the mirror's copy of them. Deleted leads stay matchable: this tool
          // has always found one, and hiding it here would be a behaviour change
          // dressed as a migration -- recorded as a finding instead.
          const [lead] = await this.db
            .select({
              id: LEAD_PARTY_COLUMNS.id,
              name: LEAD_PARTY_COLUMNS.name,
              status: LEAD_PARTY_COLUMNS.status,
              priority: LEAD_PARTY_COLUMNS.priority,
            })
            .from(leadPartyMap)
            .innerJoin(businessParties, LEAD_PARTY_JOIN)
            .where(
              and(
                ...leadPartyScope(orgId, INCLUDE_DELETED),
                isNumeric
                  ? leadIdIs(Number(leadIdentifier))
                  : ilike(LEAD_PARTY_COLUMNS.name, `%${leadIdentifier}%`),
              ),
            )
            // A name match can hit several leads and the old read took whichever
            // the heap offered first; reading through the map changes that order,
            // so the pick is stated rather than inherited.
            .orderBy(asc(LEAD_PARTY_COLUMNS.id))
            .limit(1);
          if (!lead) return { success: false, message: `Lead "${leadIdentifier}" not found.` };

          const updateData: Partial<{ status: string; priority: string }> = {};
          if (status) updateData.status = status;
          if (priority) updateData.priority = priority;
          if (Object.keys(updateData).length === 0) {
            return { success: false, message: "No status or priority provided to update." };
          }

          // Through the writer, which re-asserts `orgId` on the write as well as
          // on the lookup above: this controller is `@NoTenantTransaction`, so
          // there is no RLS predicate standing behind a missing tenant clause.
          await updateMirroredLeads(this.db, orgId, [lead.id], updateData);
          return {
            success: true,
            message: `Lead "${lead.name}" updated: ${status ? `status → ${status}` : ""}${status && priority ? ", " : ""}${priority ? `priority → ${priority}` : ""}`,
          };
        },
      }),

      createTask: tool({
        description:
          "Create a new task for the user. Use when the user asks to create, add, or remind about a task.",
        inputSchema: z.object({
          title: z.string().min(1).max(200).describe("Task title"),
          notes: z.string().optional().describe("Additional notes"),
          type: z.enum(["CALL", "EMAIL", "MEETING", "CUSTOM"]).default("CUSTOM"),
          dueDate: z.string().optional().describe("ISO date string for due date, e.g. 2026-04-15"),
        }),
        execute: async ({ title, notes, type, dueDate }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "tasks:write");
          if (deny) return { denied: true, reason: deny };

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
          return { success: true, message: `Task "${title}" created successfully.` };
        },
      }),

      searchLeads: tool({
        description:
          "Search for leads by name, company, or status to answer user questions about their pipeline.",
        inputSchema: z.object({
          query: z.string().describe("Name, company, or partial match to search"),
          status: z.enum(["NEW", "CONTACTED", "INTERESTED", "QUALIFIED", "CONVERTED", "LOST"]).optional(),
          limit: z.number().int().min(1).max(10).default(5),
        }),
        execute: async ({ query, status, limit }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "crm:leads:view");
          if (deny) return { denied: true, reason: deny };

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
            .where(
              and(
                ...leadPartyScope(orgId, INCLUDE_DELETED),
                ilike(LEAD_PARTY_COLUMNS.name, `%${query}%`),
                status ? eq(LEAD_PARTY_COLUMNS.status, status) : undefined,
              ),
            )
            // `created_at` is not unique, so the id breaks the tie and a second
            // page of the same search cannot repeat or skip a lead.
            .orderBy(desc(LEAD_PARTY_COLUMNS.createdAt), desc(LEAD_PARTY_COLUMNS.id))
            .limit(limit);
          if (results.length === 0) return { results: [], message: `No leads found matching "${query}".` };
          return { results, message: `Found ${results.length} lead(s).` };
        },
      }),
    };
  }
}
