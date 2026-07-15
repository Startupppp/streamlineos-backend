import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, lt, ne, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { projects, tickets, sprints, changeRequests, projectApprovals, roadmapItems, users } from "../../../db/schema";
import { LlmService } from "../providers/llm.service";
import { AuditService } from "../../../common/audit/audit.service";
import {
  PmSummaryOutputSchema,
  PmRisksOutputSchema,
  PmClientUpdateOutputSchema,
  PmPlanOutputSchema,
  PmExtractOutputSchema,
  PmAskOutputSchema,
} from "../dto/pm.schemas";
import {
  summaryPrompt,
  risksPrompt,
  clientUpdatePrompt,
  planPrompt,
  extractPrompt,
  askPrompt,
} from "../prompts/pm.prompts";

const NO_DATA = {
  noData: true,
  message: "This project has no tickets yet. Add tasks to unlock AI features.",
} as const;

@Injectable()
export class ProjectsAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly llm: LlmService,
    private readonly audit: AuditService,
  ) {}

  private async assertProject(orgId: string, projectId: number) {
    const [p] = await this.db
      .select({ id: projects.id, name: projects.name, status: projects.status, description: projects.description, endDate: projects.endDate })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)));
    if (!p) throw new NotFoundException("Project not found");
    return p;
  }

  private async fetchTicketRows(orgId: string, projectId: number) {
    return this.db
      .select({ status: tickets.status, dueDate: tickets.dueDate, sprintId: tickets.sprintId })
      .from(tickets)
      .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)));
  }

  private async fetchAssigneeStats(orgId: string, projectId: number) {
    const nowStr = new Date().toISOString().split("T")[0];
    const rows = await this.db
      .select({
        assigneeId: tickets.assigneeId,
        assigneeName: sql<string | null>`COALESCE(NULLIF(TRIM(CONCAT(${users.firstName}, ' ', ${users.lastName})), ''), ${users.name})`,
        total: count(),
        done: count(sql`CASE WHEN ${tickets.status} = 'DONE' THEN 1 END`),
        inProgress: count(sql`CASE WHEN ${tickets.status} IN ('IN_PROGRESS','IN_REVIEW') THEN 1 END`),
        overdue: count(sql`CASE WHEN ${tickets.dueDate} IS NOT NULL AND ${tickets.dueDate} < ${nowStr} AND ${tickets.status} != 'DONE' THEN 1 END`),
      })
      .from(tickets)
      .leftJoin(users, eq(users.id, tickets.assigneeId))
      .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)))
      .groupBy(tickets.assigneeId, users.firstName, users.lastName, users.name)
      .limit(50);

    return rows;
  }

  private buildMemberEvidenceLine(rows: Array<{ assigneeId: string | null; assigneeName: string | null; total: number; done: number; inProgress: number; overdue: number }>): string {
    const assigned = rows.filter((r) => r.assigneeId !== null);
    const unassigned = rows.find((r) => r.assigneeId === null);

    const parts = assigned.map((r) => {
      const name = r.assigneeName ?? r.assigneeId ?? "Unknown";
      const total = Number(r.total);
      const done = Number(r.done);
      const inProg = Number(r.inProgress);
      return `${name} — ${total} total (${done} done, ${inProg} in progress)`;
    });

    if (unassigned && Number(unassigned.total) > 0) {
      parts.push(`Unassigned — ${Number(unassigned.total)} total`);
    }

    return parts.length > 0 ? `Members: ${parts.join("; ")}` : "Members: none";
  }

  async summarize(orgId: string, projectId: number, userId: string) {
    const project = await this.assertProject(orgId, projectId);
    const rows = await this.fetchTicketRows(orgId, projectId);
    if (rows.length === 0) {
      return { summary: NO_DATA.message, highlights: [], atRisk: false, evidence: { totalTasks: 0, done: 0, inProgress: 0, blocked: 0, overdue: 0 } };
    }

    const now = new Date();
    const nowStr = now.toISOString().split("T")[0];
    const totalTasks = rows.length;
    const done = rows.filter((r) => r.status === "DONE").length;
    const inProgress = rows.filter((r) => ["IN_PROGRESS", "IN_REVIEW"].includes(r.status)).length;
    const blocked = rows.filter((r) => r.status === "BLOCKED").length;
    const overdue = rows.filter((r) => r.dueDate !== null && r.dueDate < nowStr && r.status !== "DONE").length;

    const [activeSprint] = await this.db
      .select({ id: sprints.id })
      .from(sprints)
      .where(and(eq(sprints.projectId, projectId), eq(sprints.orgId, orgId), eq(sprints.status, "ACTIVE")))
      .limit(1);

    let sprintProgressPct: number | undefined;
    if (activeSprint) {
      const sprintRows = rows.filter((r) => r.sprintId === activeSprint.id);
      const sprintDone = sprintRows.filter((r) => r.status === "DONE").length;
      sprintProgressPct = sprintRows.length > 0 ? Math.round((sprintDone / sprintRows.length) * 100) : undefined;
    }

    const { system, user } = summaryPrompt({ projectName: project.name, status: project.status, totalTasks, done, inProgress, blocked, overdue, sprintProgressPct });
    const llmResult = await this.llm.invokeStructured({ model: "fast", schema: PmSummaryOutputSchema, schemaName: "ProjectSummary", system, user });
    this.audit.log({ action: "ai.project.summary", userId, orgId, resourceType: "project", resourceId: String(projectId) });
    return { ...llmResult, evidence: { totalTasks, done, inProgress, blocked, overdue, sprintProgressPct } };
  }

  async detectRisks(orgId: string, projectId: number, userId: string) {
    const project = await this.assertProject(orgId, projectId);
    const rows = await this.fetchTicketRows(orgId, projectId);
    if (rows.length === 0) {
      return { risks: [], evidence: { totalTasks: 0, done: 0, inProgress: 0, blocked: 0, overdue: 0 } };
    }

    const nowStr = new Date().toISOString().split("T")[0];
    const totalTasks = rows.length;
    const doneTasks = rows.filter((r) => r.status === "DONE").length;
    const inProgressTasks = rows.filter((r) => ["IN_PROGRESS", "IN_REVIEW"].includes(r.status)).length;
    const overdueTasks = rows.filter((r) => r.dueDate !== null && r.dueDate < nowStr && r.status !== "DONE").length;
    const blockedTasks = rows.filter((r) => r.status === "BLOCKED").length;

    const [sprResults, crResults, apResults] = await Promise.all([
      this.db.select({ count: count() }).from(sprints)
        .where(and(eq(sprints.projectId, projectId), eq(sprints.orgId, orgId), eq(sprints.status, "ACTIVE"), lt(sprints.endDate, sql`now()`))),
      this.db.select({ count: count() }).from(changeRequests)
        .where(and(eq(changeRequests.projectId, projectId), eq(changeRequests.orgId, orgId), ne(changeRequests.status, "approved"), ne(changeRequests.status, "rejected"), ne(changeRequests.status, "completed"))),
      this.db.select({ count: count() }).from(projectApprovals)
        .where(and(eq(projectApprovals.projectId, projectId), eq(projectApprovals.orgId, orgId), ne(projectApprovals.status, "approved"), ne(projectApprovals.status, "rejected"), ne(projectApprovals.status, "cancelled"))),
    ]);

    const activeSprintsOverdue = sprResults[0]?.count ?? 0;
    const openChangeRequests = crResults[0]?.count ?? 0;
    const pendingApprovals = apResults[0]?.count ?? 0;
    const daysUntilDeadline = project.endDate
      ? Math.ceil((project.endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      : undefined;

    const { system, user } = risksPrompt({ projectName: project.name, overdueTasks, blockedTasks, activeSprintsOverdue, openChangeRequests, pendingApprovals, daysUntilDeadline });
    const llmResult = await this.llm.invokeStructured({ model: "fast", schema: PmRisksOutputSchema, schemaName: "ProjectRisks", system, user });
    this.audit.log({ action: "ai.project.risks", userId, orgId, resourceType: "project", resourceId: String(projectId) });
    return { ...llmResult, evidence: { totalTasks, done: doneTasks, inProgress: inProgressTasks, blocked: blockedTasks, overdue: overdueTasks } };
  }

  async draftClientUpdate(orgId: string, projectId: number, userId: string) {
    const project = await this.assertProject(orgId, projectId);
    const rows = await this.fetchTicketRows(orgId, projectId);
    if (rows.length === 0) {
      return { headline: NO_DATA.message, body: "", sections: [] };
    }

    const [visibleTickets, visibleMilestones] = await Promise.all([
      this.db
        .select({ title: tickets.title, status: tickets.status, priority: tickets.priority })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId), eq(tickets.clientVisible, true)))
        .limit(50),
      this.db
        .select({ title: roadmapItems.title, status: roadmapItems.status })
        .from(roadmapItems)
        .where(and(eq(roadmapItems.projectId, projectId), eq(roadmapItems.isPublic, true)))
        .limit(20),
    ]);

    const { system, user } = clientUpdatePrompt({ projectName: project.name, visibleTasks: visibleTickets, visibleMilestones });
    const llmResult = await this.llm.invokeStructured({ model: "fast", schema: PmClientUpdateOutputSchema, schemaName: "ClientUpdate", system, user });
    this.audit.log({ action: "ai.project.client-update", userId, orgId, resourceType: "project", resourceId: String(projectId) });
    return llmResult;
  }

  async proposePlan(orgId: string, projectId: number, userPrompt: string, userId: string) {
    const project = await this.assertProject(orgId, projectId);

    const openTitles = await this.db
      .select({ title: tickets.title })
      .from(tickets)
      .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId), ne(tickets.status, "DONE")))
      .limit(50);

    const { system, user } = planPrompt({ projectName: project.name, projectDescription: project.description, existingOpenTaskTitles: openTitles.map((t) => t.title), userPrompt });
    const llmResult = await this.llm.invokeStructured({ model: "fast", schema: PmPlanOutputSchema, schemaName: "ProjectPlan", system, user });
    this.audit.log({ action: "ai.project.plan", userId, orgId, resourceType: "project", resourceId: String(projectId) });
    return { ...llmResult, suggestions: true };
  }

  async extractTasks(orgId: string, projectId: number, text: string, userId: string) {
    const project = await this.assertProject(orgId, projectId);

    const openTitles = await this.db
      .select({ title: tickets.title })
      .from(tickets)
      .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId), ne(tickets.status, "DONE")))
      .limit(50);

    const { system, user } = extractPrompt({ projectName: project.name, existingOpenTaskTitles: openTitles.map((t) => t.title), text });
    const llmResult = await this.llm.invokeStructured({ model: "fast", schema: PmExtractOutputSchema, schemaName: "ExtractTasks", system, user });
    this.audit.log({ action: "ai.project.extract-tasks", userId, orgId, resourceType: "project", resourceId: String(projectId) });
    return { ...llmResult, suggestions: true };
  }

  async ask(orgId: string, projectId: number, question: string, userId: string) {
    const project = await this.assertProject(orgId, projectId);
    const [rows, assigneeRows] = await Promise.all([
      this.fetchTicketRows(orgId, projectId),
      this.fetchAssigneeStats(orgId, projectId),
    ]);

    const nowStr = new Date().toISOString().split("T")[0];
    const totalTasks = rows.length;
    const done = rows.filter((r) => r.status === "DONE").length;
    const inProgress = rows.filter((r) => ["IN_PROGRESS", "IN_REVIEW"].includes(r.status)).length;
    const blocked = rows.filter((r) => r.status === "BLOCKED").length;
    const overdue = rows.filter((r) => r.dueDate !== null && r.dueDate < nowStr && r.status !== "DONE").length;

    const memberLine = this.buildMemberEvidenceLine(assigneeRows);
    const evidence = `Total tasks: ${totalTasks} | Done: ${done} | In progress: ${inProgress} | Blocked: ${blocked} | Overdue: ${overdue} | Project status: ${project.status}\n${memberLine}`;
    const { system, user } = askPrompt({ projectName: project.name, evidence, question });
    const llmResult = await this.llm.invokeStructured({ model: "fast", schema: PmAskOutputSchema, schemaName: "ProjectAsk", system, user });
    this.audit.log({ action: "ai.project.ask", userId, orgId, resourceType: "project", resourceId: String(projectId) });
    return { ...llmResult, evidence: { totalTasks, done, inProgress, blocked, overdue } };
  }
}
