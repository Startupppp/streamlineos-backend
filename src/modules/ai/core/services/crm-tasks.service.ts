import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, inArray, isNull, sql, sum } from "drizzle-orm";
import { crmDeals, organizationMembers, tasks, tickets, timesheets, users } from "../../../../db/schema";
import { businessParties, leadPartyMap } from "../../../../db/schema/party";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import {
  INCLUDE_DELETED,
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadIdIn,
  leadPartyScope,
} from "../../../leads/lead-party-reader";
import { AiGatewayService } from "../gateway/ai-gateway.service";

import { PriorityResponseSchema } from "../dto/output.schemas";
import { formatDateOnly } from "../../../../common/date";
import { throwOnAiFailure } from "./gateway-result.util";

export interface TaskSuggestion {
  ticketId: number;
  title: string;
  reason: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
}

export interface WorkloadAnalysis {
  userId: string;
  userName: string;
  activeTickets: number;
  totalPoints: number;
  hoursThisWeek: number;
  recommendation: "AVAILABLE" | "MODERATE" | "HEAVY" | "OVERLOADED";
}

function diffHours(a: Date, b: Date): number {
  return Math.trunc((a.getTime() - b.getTime()) / (1000 * 60 * 60));
}

@Injectable()
export class CrmTasksService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  async prioritizeTasks(orgId: string, userId: string) {
    const enriched = await runInTenantTransaction(this.db, async (tx) => {
      const pendingTasks = await tx
        .select({
          id: tasks.id,
          title: tasks.title,
          type: tasks.type,
          notes: tasks.notes,
          dueDate: tasks.dueDate,
          entityType: tasks.entityType,
          entityId: tasks.entityId,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.orgId, orgId),
            eq(tasks.assigneeId, userId),
            eq(tasks.status, "pending"),
            isNull(tasks.completedAt),
          ),
        )
        .limit(30);

      if (pendingTasks.length === 0) return null;

      const idsOf = (entityType: string): number[] => [
        ...new Set(
          pendingTasks.flatMap((t) => (t.entityType === entityType && t.entityId ? [t.entityId] : [])),
        ),
      ];
      const leadIds = idsOf("LEAD");
      const dealIds = idsOf("DEAL");

      const leadRows = leadIds.length === 0 ? [] : await tx
        .select({
          id: LEAD_PARTY_COLUMNS.id,
          name: LEAD_PARTY_COLUMNS.name,
          score: LEAD_PARTY_COLUMNS.score,
          potentialValue: LEAD_PARTY_COLUMNS.potentialValue,
          slaDeadline: LEAD_PARTY_COLUMNS.slaDeadline,
          status: LEAD_PARTY_COLUMNS.status,
          priority: LEAD_PARTY_COLUMNS.priority,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(and(...leadPartyScope(orgId, INCLUDE_DELETED), leadIdIn(leadIds)))
        .limit(leadIds.length);
      const leadsById = new Map(leadRows.map((lead) => [lead.id, lead]));

      const dealRows = dealIds.length === 0 ? [] : await tx
        .select({
          id: crmDeals.id,
          companyName: crmDeals.companyName,
          value: crmDeals.value,
          stage: crmDeals.stage,
          closeDate: crmDeals.closeDate,
        })
        .from(crmDeals)
        .where(and(inArray(crmDeals.id, dealIds), eq(crmDeals.orgId, orgId)))
        .limit(dealIds.length);
      const dealsById = new Map(dealRows.map((deal) => [deal.id, deal]));

      return pendingTasks.map((t) => {
        let entityContext: Record<string, unknown> = {};

        const lead = t.entityType === "LEAD" && t.entityId ? leadsById.get(t.entityId) : undefined;
        if (lead) {
          const slaHoursLeft = lead.slaDeadline ? diffHours(new Date(lead.slaDeadline), new Date()) : null;
          entityContext = {
            type: "LEAD",
            name: lead.name,
            score: lead.score ?? 0,
            potentialValue: lead.potentialValue ? parseFloat(String(lead.potentialValue)) : 0,
            slaHoursLeft,
            slaMissed: slaHoursLeft !== null && slaHoursLeft < 0,
            priority: lead.priority,
            status: lead.status,
          };
        }

        const deal = t.entityType === "DEAL" && t.entityId ? dealsById.get(t.entityId) : undefined;
        if (deal) {
          const closeDaysLeft = deal.closeDate ? diffHours(new Date(deal.closeDate), new Date()) / 24 : null;
          entityContext = {
            type: "DEAL",
            companyName: deal.companyName,
            value: deal.value ? parseFloat(String(deal.value)) : 0,
            stage: deal.stage,
            closeDaysLeft: closeDaysLeft !== null ? Math.round(closeDaysLeft) : null,
          };
        }

        const dueHoursLeft = t.dueDate ? diffHours(new Date(t.dueDate), new Date()) : null;

        return {
          taskId: t.id,
          title: t.title,
          type: t.type,
          notes: t.notes,
          dueHoursLeft,
          overdue: dueHoursLeft !== null && dueHoursLeft < 0,
          entityContext,
        };
      });
    }, { orgId });

    if (enriched === null) {
      return { items: [], summary: "No pending tasks to prioritize." };
    }

    const taskListJson = JSON.stringify(enriched, null, 2);

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "crm.prioritize-tasks",
      prompt: {
        system: `You are a sales productivity assistant. Your job is to rank a sales rep's pending tasks by urgency and business impact.

Ranking criteria (in order of importance):
1. SLA breaches — tasks tied to leads with an overdue SLA MUST be ranked highest
2. Overdue tasks — tasks past their due date
3. Lead score + potential value — higher score / value = higher priority
4. Due soon — tasks due within 24h rank above those due in 3+ days
5. Deal close date proximity — tasks for deals closing soon rank higher
6. Task type — CALL > MEETING > EMAIL > CUSTOM when all else is equal

For each task return:
- taskId (exact integer from input)
- rank (1 = highest priority)
- urgencyScore (0–100, where 100 = "do this right now")
- reasoning (1-2 sentences explaining why this rank)

Also return a short summary (2-3 sentences) with overall advice for the rep.`,
        user: `Here are my ${enriched.length} pending tasks. Please prioritize them:\n\n${taskListJson}`,
      },
      schema: PriorityResponseSchema,
      tier: "fast",
      maxTokens: 1024,
      charge: true,
    });

    if (!result.ok) throwOnAiFailure(result);
    return result.data;
  }

  async suggestTaskAssignments(orgId: string, projectId: number): Promise<TaskSuggestion[]> {
    const projectTickets = await runInTenantTransaction(this.db, (tx) =>
      tx.query.tickets.findMany({
        where: and(eq(tickets.orgId, orgId), eq(tickets.projectId, projectId), eq(tickets.status, "TODO"), isNull(tickets.deletedAt)),
        columns: { id: true, title: true, priority: true, assigneeMembershipId: true },
        limit: 100,
      }),
      { orgId },
    );

    const unassignedTickets = projectTickets.filter((t) => !t.assigneeMembershipId);

    return unassignedTickets.slice(0, 5).map((ticket) => ({
      ticketId: ticket.id,
      title: ticket.title,
      reason: "Unassigned ticket needs attention",
      priority: ticket.priority || "MEDIUM",
    }));
  }

  async analyzeWorkload(orgId: string): Promise<WorkloadAnalysis[]> {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const { ticketAgg, hoursAgg } = await runInTenantTransaction(this.db, async (tx) => {
      const [ticketAgg, hoursAgg] = await Promise.all([
        tx
          .select({
            assigneeId: organizationMembers.userId,
            activeTickets: count(),
            totalPoints: sum(tickets.points),
            userName: users.firstName,
          })
          .from(tickets)
          .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, tickets.orgId), eq(organizationMembers.id, tickets.assigneeMembershipId)))
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(
            and(
              eq(tickets.orgId, orgId),
              isNull(tickets.deletedAt),
              sql`${tickets.status} IN ('TODO', 'IN_PROGRESS', 'IN_REVIEW')`,
            ),
          )
          .groupBy(organizationMembers.userId, users.firstName)
          .limit(200),
        tx
          .select({
            userId: organizationMembers.userId,
            hoursThisWeek: sum(timesheets.hours),
          })
          .from(timesheets)
          .innerJoin(
            organizationMembers,
            and(
              eq(timesheets.orgId, organizationMembers.orgId),
              eq(timesheets.userMembershipId, organizationMembers.id),
            ),
          )
          .where(
            and(
              eq(timesheets.orgId, orgId),
              sql`${timesheets.date} >= ${formatDateOnly(weekAgo)}`,
            ),
          )
          .groupBy(organizationMembers.userId)
          .limit(200),
      ]);
      return { ticketAgg, hoursAgg };
    }, { orgId });

    const hoursMap = new Map(
      hoursAgg.map((r) => [r.userId, parseFloat(r.hoursThisWeek ?? "0")]),
    );

    const analyses: WorkloadAnalysis[] = ticketAgg
      .filter((r) => r.assigneeId !== null)
      .map((r) => {
        const activeTickets = Number(r.activeTickets);
        const totalPoints = Number(r.totalPoints ?? 0);
        const hoursThisWeek = hoursMap.get(r.assigneeId) ?? 0;

        let recommendation: WorkloadAnalysis["recommendation"] = "AVAILABLE";
        if (hoursThisWeek > 40 || activeTickets > 10) {
          recommendation = "OVERLOADED";
        } else if (hoursThisWeek > 30 || activeTickets > 7) {
          recommendation = "HEAVY";
        } else if (hoursThisWeek > 20 || activeTickets > 4) {
          recommendation = "MODERATE";
        }

        return {
          userId: r.assigneeId,
          userName: r.userName ?? "Unknown",
          activeTickets,
          totalPoints,
          hoursThisWeek,
          recommendation,
        };
      });

    return analyses;
  }
}
