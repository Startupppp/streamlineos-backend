import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { crmDeals, leads, tasks, tickets, timesheets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { LlmService } from "../providers/llm.service";
import { PriorityResponseSchema } from "../dto/output.schemas";
import { formatDateOnly } from "../ai-date.util";

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
    private readonly llm: LlmService,
  ) {}

  async prioritizeTasks(orgId: string, userId: string) {
    const pendingTasks = await this.db
      .select()
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

    if (pendingTasks.length === 0) {
      return { items: [], summary: "No pending tasks to prioritize." };
    }

    const enriched = await Promise.all(
      pendingTasks.map(async (t) => {
        let entityContext: Record<string, unknown> = {};

        if (t.entityType === "LEAD" && t.entityId) {
          const [lead] = await this.db
            .select({
              id: leads.id,
              name: leads.name,
              score: leads.score,
              potentialValue: leads.potentialValue,
              slaDeadline: leads.slaDeadline,
              status: leads.status,
              priority: leads.priority,
            })
            .from(leads)
            .where(and(eq(leads.id, t.entityId), eq(leads.orgId, orgId)))
            .limit(1);

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
        } else if (t.entityType === "DEAL" && t.entityId) {
          const [deal] = await this.db
            .select({
              id: crmDeals.id,
              companyName: crmDeals.companyName,
              value: crmDeals.value,
              stage: crmDeals.stage,
              closeDate: crmDeals.closeDate,
            })
            .from(crmDeals)
            .where(and(eq(crmDeals.id, t.entityId), eq(crmDeals.orgId, orgId)))
            .limit(1);

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
      }),
    );

    const taskListJson = JSON.stringify(enriched, null, 2);

    return this.llm.invokeStructured({
      model: "fast",
      schema: PriorityResponseSchema,
      schemaName: "task_priority",
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
    });
  }

  async suggestTaskAssignments(orgId: string, projectId: number): Promise<TaskSuggestion[]> {
    const projectTickets = await this.db.query.tickets.findMany({
      where: and(eq(tickets.orgId, orgId), eq(tickets.projectId, projectId), eq(tickets.status, "TODO")),
      with: { assignee: true },
    });

    const unassignedTickets = projectTickets.filter((t) => !t.assigneeId);

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

    const activeTickets = await this.db.query.tickets.findMany({
      where: and(eq(tickets.orgId, orgId), sql`${tickets.status} IN ('TODO', 'IN_PROGRESS', 'IN_REVIEW')`),
      with: { assignee: true },
    });

    const timeEntries = await this.db.query.timesheets.findMany({
      where: and(eq(timesheets.orgId, orgId), sql`${timesheets.date} >= ${formatDateOnly(weekAgo)}`),
    });

    const userWorkload = new Map<string, WorkloadAnalysis>();

    for (const ticket of activeTickets) {
      if (!ticket.assigneeId) continue;
      const existing = userWorkload.get(ticket.assigneeId);
      const points = ticket.points || 0;
      if (existing) {
        existing.activeTickets += 1;
        existing.totalPoints += points;
      } else {
        userWorkload.set(ticket.assigneeId, {
          userId: ticket.assigneeId,
          userName: ticket.assignee?.firstName || "Unknown",
          activeTickets: 1,
          totalPoints: points,
          hoursThisWeek: 0,
          recommendation: "AVAILABLE",
        });
      }
    }

    for (const entry of timeEntries) {
      if (!entry.userId) continue;
      const workload = userWorkload.get(entry.userId);
      if (workload) workload.hoursThisWeek += parseFloat(entry.hours || "0");
    }

    const analyses = Array.from(userWorkload.values());
    for (const analysis of analyses) {
      if (analysis.hoursThisWeek > 40 || analysis.activeTickets > 10) {
        analysis.recommendation = "OVERLOADED";
      } else if (analysis.hoursThisWeek > 30 || analysis.activeTickets > 7) {
        analysis.recommendation = "HEAVY";
      } else if (analysis.hoursThisWeek > 20 || analysis.activeTickets > 4) {
        analysis.recommendation = "MODERATE";
      } else {
        analysis.recommendation = "AVAILABLE";
      }
    }

    return analyses;
  }
}
