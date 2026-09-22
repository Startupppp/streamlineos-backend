import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, isNull, gte, lte, lt, ne, notInArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { projects, tickets, cycles, changeRequests, projectApprovals, roadmapItems, organizationMembers, users, projectRisks, projectDecisions } from "../../../../db/schema";
import { AuditService } from "../../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import {
  PmSummaryOutputSchema,
  PmRisksOutputSchema,
  PmClientUpdateOutputSchema,
  PmPlanOutputSchema,
  PmExtractOutputSchema,
  PmAskOutputSchema,
  PmWeeklyUpdateOutputSchema,
  PmChangeImpactOutputSchema,
} from "../dto/pm.schemas";
import {
  summaryPrompt,
  risksPrompt,
  clientUpdatePrompt,
  planPrompt,
  extractPrompt,
  askPrompt,
  weeklyUpdatePrompt,
  changeImpactPrompt,
} from "../prompts/pm.prompts";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { unwrapAiResult } from "./gateway-result.util";

const NO_DATA = {
  noData: true,
  message: "This project has no tickets yet. Add tasks to unlock AI features.",
} as const;

const TEXT_LIMIT = 2000;

@Injectable()
export class ProjectsAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly audit: AuditService,
  ) {}

  private async assertProject(orgId: string, projectId: number) {
    const [p] = await this.db
      .select({ id: projects.id, name: projects.name, status: projects.status, description: projects.description, endDate: projects.endDate })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)));
    if (!p) throw new NotFoundException("Project not found");
    return p;
  }

  private async fetchTicketRows(orgId: string, projectId: number) {
    return this.db
      .select({ status: tickets.status, dueDate: tickets.dueDate, cycleId: tickets.cycleId })
      .from(tickets)
      .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)));
  }

  private async fetchAssigneeStats(orgId: string, projectId: number) {
    const nowStr = new Date().toISOString().split("T")[0];
    return this.db
      .select({
        assigneeId: organizationMembers.userId,
        assigneeName: sql<string | null>`COALESCE(NULLIF(TRIM(CONCAT(${users.firstName}, ' ', ${users.lastName})), ''), ${users.name})`,
        total: count(),
        done: count(sql`CASE WHEN ${tickets.status} = 'DONE' THEN 1 END`),
        inProgress: count(sql`CASE WHEN ${tickets.status} IN ('IN_PROGRESS','IN_REVIEW') THEN 1 END`),
        overdue: count(sql`CASE WHEN ${tickets.dueDate} IS NOT NULL AND ${tickets.dueDate} < ${nowStr} AND ${tickets.status} != 'DONE' THEN 1 END`),
      })
      .from(tickets)
      .leftJoin(organizationMembers, and(eq(organizationMembers.orgId, tickets.orgId), eq(organizationMembers.id, tickets.assigneeMembershipId)))
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
      .groupBy(organizationMembers.userId, users.firstName, users.lastName, users.name)
      .limit(50);
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
    const ctx = await runInTenantTransaction(this.db, async () => {
      const project = await this.assertProject(orgId, projectId);
      const rows = await this.fetchTicketRows(orgId, projectId);
      if (rows.length === 0) return { empty: true as const };
      const [activeCycle] = await this.db
        .select({ id: cycles.id })
        .from(cycles)
        .where(and(eq(cycles.projectId, projectId), eq(cycles.orgId, orgId), eq(cycles.status, "active")))
        .limit(1);
      return { empty: false as const, project, rows, activeCycle };
    }, { orgId });

    if (ctx.empty) {
      return { summary: NO_DATA.message, highlights: [], atRisk: false, evidence: { totalTasks: 0, done: 0, inProgress: 0, blocked: 0, overdue: 0 } };
    }

    const { project, rows, activeCycle } = ctx;
    const nowStr = new Date().toISOString().split("T")[0];
    const totalTasks = rows.length;
    const done = rows.filter((r) => r.status === "DONE").length;
    const inProgress = rows.filter((r) => ["IN_PROGRESS", "IN_REVIEW"].includes(r.status)).length;
    const blocked = rows.filter((r) => r.status === "BLOCKED").length;
    const overdue = rows.filter((r) => r.dueDate !== null && r.dueDate < nowStr && r.status !== "DONE").length;

    let sprintProgressPct: number | undefined;
    if (activeCycle) {
      const cycleRows = rows.filter((r) => r.cycleId === activeCycle.id);
      const cycleDone = cycleRows.filter((r) => r.status === "DONE").length;
      sprintProgressPct = cycleRows.length > 0 ? Math.round((cycleDone / cycleRows.length) * 100) : undefined;
    }

    const { system, user } = summaryPrompt({ projectName: project.name, status: project.status, totalTasks, done, inProgress, blocked, overdue, sprintProgressPct });
    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "pm.summary",
      prompt: { system, user, promptKey: "pm.summary", promptVersion: 1 },
      schema: PmSummaryOutputSchema,
      tier: "fast",
      maxTokens: 768,
      charge: true,
      dedupe: true,
    });

    const data = unwrapAiResult(result);
    this.audit.log({ action: "ai.project.summary", userId, orgId, resourceType: "project", resourceId: String(projectId) });
    return { ...data, evidence: { totalTasks, done, inProgress, blocked, overdue, sprintProgressPct } };
  }

  async detectRisks(orgId: string, projectId: number, userId: string) {
    const ctx = await runInTenantTransaction(this.db, async () => {
      const project = await this.assertProject(orgId, projectId);
      const rows = await this.fetchTicketRows(orgId, projectId);
      if (rows.length === 0) return { empty: true as const };
      const [sprResults, crResults, apResults] = await Promise.all([
        this.db.select({ count: count() }).from(sprints)
          .where(and(eq(sprints.projectId, projectId), eq(sprints.orgId, orgId), eq(sprints.status, "ACTIVE"), lt(sprints.endDate, sql`now()`), isNull(sprints.deletedAt))),
        this.db.select({ count: count() }).from(changeRequests)
          .where(and(eq(changeRequests.projectId, projectId), eq(changeRequests.orgId, orgId), ne(changeRequests.status, "approved"), ne(changeRequests.status, "rejected"), ne(changeRequests.status, "completed"))),
        this.db.select({ count: count() }).from(projectApprovals)
          .where(and(eq(projectApprovals.projectId, projectId), eq(projectApprovals.orgId, orgId), ne(projectApprovals.status, "approved"), ne(projectApprovals.status, "rejected"), ne(projectApprovals.status, "cancelled"))),
      ]);
      return { empty: false as const, project, rows, sprResults, crResults, apResults };
    }, { orgId });

    if (ctx.empty) {
      return { risks: [], evidence: { totalTasks: 0, done: 0, inProgress: 0, blocked: 0, overdue: 0 } };
    }

    const { project, rows, sprResults, crResults, apResults } = ctx;
    const nowStr = new Date().toISOString().split("T")[0];
    const totalTasks = rows.length;
    const doneTasks = rows.filter((r) => r.status === "DONE").length;
    const inProgressTasks = rows.filter((r) => ["IN_PROGRESS", "IN_REVIEW"].includes(r.status)).length;
    const overdueTasks = rows.filter((r) => r.dueDate !== null && r.dueDate < nowStr && r.status !== "DONE").length;
    const blockedTasks = rows.filter((r) => r.status === "BLOCKED").length;

    const activeSprintsOverdue = sprResults[0]?.count ?? 0;
    const openChangeRequests = crResults[0]?.count ?? 0;
    const pendingApprovals = apResults[0]?.count ?? 0;
    const daysUntilDeadline = project.endDate
      ? Math.ceil((project.endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      : undefined;

    const { system, user } = risksPrompt({ projectName: project.name, overdueTasks, blockedTasks, activeSprintsOverdue, openChangeRequests, pendingApprovals, daysUntilDeadline });
    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "pm.risks",
      prompt: { system, user, promptKey: "pm.risks", promptVersion: 1 },
      schema: PmRisksOutputSchema,
      tier: "fast",
      maxTokens: 768,
      charge: true,
    });

    const data = unwrapAiResult(result);
    this.audit.log({ action: "ai.project.risks", userId, orgId, resourceType: "project", resourceId: String(projectId) });
    return { ...data, evidence: { totalTasks, done: doneTasks, inProgress: inProgressTasks, blocked: blockedTasks, overdue: overdueTasks } };
  }

  async draftClientUpdate(orgId: string, projectId: number, userId: string) {
    const ctx = await runInTenantTransaction(this.db, async () => {
      const project = await this.assertProject(orgId, projectId);
      const rows = await this.fetchTicketRows(orgId, projectId);
      if (rows.length === 0) return { empty: true as const };
      const [visibleTickets, visibleMilestones] = await Promise.all([
        this.db
          .select({ title: tickets.title, status: tickets.status, priority: tickets.priority })
          .from(tickets)
          .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId), eq(tickets.clientVisible, true), isNull(tickets.deletedAt)))
          .limit(50),
        this.db
          .select({ title: roadmapItems.title, status: roadmapItems.status })
          .from(roadmapItems)
          .where(and(eq(roadmapItems.projectId, projectId), eq(roadmapItems.isPublic, true), isNull(roadmapItems.deletedAt)))
          .limit(20),
      ]);
      return { empty: false as const, project, visibleTickets, visibleMilestones };
    }, { orgId });

    if (ctx.empty) {
      return { headline: NO_DATA.message, body: "", sections: [] };
    }

    const { project, visibleTickets, visibleMilestones } = ctx;
    const { system, user } = clientUpdatePrompt({ projectName: project.name, visibleTasks: visibleTickets, visibleMilestones });
    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "pm.client-update",
      prompt: { system, user, promptKey: "pm.client_update", promptVersion: 1 },
      schema: PmClientUpdateOutputSchema,
      tier: "fast",
      maxTokens: 1024,
      charge: true,
    });

    const data = unwrapAiResult(result);
    this.audit.log({ action: "ai.project.client-update", userId, orgId, resourceType: "project", resourceId: String(projectId) });
    return data;
  }

  async proposePlan(orgId: string, projectId: number, userPrompt: string, userId: string) {
    const { project, openTitles } = await runInTenantTransaction(this.db, async () => {
      const project = await this.assertProject(orgId, projectId);
      const openTitles = await this.db
        .select({ title: tickets.title })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId), ne(tickets.status, "DONE"), isNull(tickets.deletedAt)))
        .limit(50);
      return { project, openTitles };
    }, { orgId });

    const truncatedDescription = project.description ? project.description.slice(0, TEXT_LIMIT) : null;
    const truncatedPrompt = userPrompt.slice(0, TEXT_LIMIT);

    const { system, user } = planPrompt({ projectName: project.name, projectDescription: truncatedDescription, existingOpenTaskTitles: openTitles.map((t) => t.title), userPrompt: truncatedPrompt });
    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "pm.plan",
      prompt: { system, user, promptKey: "pm.plan", promptVersion: 1 },
      schema: PmPlanOutputSchema,
      tier: "fast",
      maxTokens: 1536,
      charge: true,
    });

    const data = unwrapAiResult(result);
    this.audit.log({ action: "ai.project.plan", userId, orgId, resourceType: "project", resourceId: String(projectId) });
    return { ...data, suggestions: true };
  }

  async extractTasks(orgId: string, projectId: number, text: string, userId: string) {
    const { project, openTitles } = await runInTenantTransaction(this.db, async () => {
      const project = await this.assertProject(orgId, projectId);
      const openTitles = await this.db
        .select({ title: tickets.title })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId), ne(tickets.status, "DONE"), isNull(tickets.deletedAt)))
        .limit(50);
      return { project, openTitles };
    }, { orgId });

    const truncatedText = text.slice(0, TEXT_LIMIT);

    const { system, user } = extractPrompt({ projectName: project.name, existingOpenTaskTitles: openTitles.map((t) => t.title), text: truncatedText });
    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "pm.extract-tasks",
      prompt: { system, user, promptKey: "pm.extract", promptVersion: 1 },
      schema: PmExtractOutputSchema,
      tier: "fast",
      maxTokens: 768,
      charge: true,
    });

    const data = unwrapAiResult(result);
    this.audit.log({ action: "ai.project.extract-tasks", userId, orgId, resourceType: "project", resourceId: String(projectId) });
    return { ...data, suggestions: true };
  }

  async ask(orgId: string, projectId: number, question: string, userId: string) {
    const { project, rows, assigneeRows } = await runInTenantTransaction(this.db, async () => {
      const project = await this.assertProject(orgId, projectId);
      const [rows, assigneeRows] = await Promise.all([
        this.fetchTicketRows(orgId, projectId),
        this.fetchAssigneeStats(orgId, projectId),
      ]);
      return { project, rows, assigneeRows };
    }, { orgId });

    const nowStr = new Date().toISOString().split("T")[0];
    const totalTasks = rows.length;
    const done = rows.filter((r) => r.status === "DONE").length;
    const inProgress = rows.filter((r) => ["IN_PROGRESS", "IN_REVIEW"].includes(r.status)).length;
    const blocked = rows.filter((r) => r.status === "BLOCKED").length;
    const overdue = rows.filter((r) => r.dueDate !== null && r.dueDate < nowStr && r.status !== "DONE").length;

    const memberLine = this.buildMemberEvidenceLine(assigneeRows);
    const evidence = `Total tasks: ${totalTasks} | Done: ${done} | In progress: ${inProgress} | Blocked: ${blocked} | Overdue: ${overdue} | Project status: ${project.status}\n${memberLine}`;
    const truncatedQuestion = question.slice(0, TEXT_LIMIT);

    const { system, user } = askPrompt({ projectName: project.name, evidence, question: truncatedQuestion });
    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "pm.ask",
      prompt: { system, user, promptKey: "pm.ask", promptVersion: 1 },
      schema: PmAskOutputSchema,
      tier: "fast",
      maxTokens: 768,
      charge: true,
    });

    const data = unwrapAiResult(result);
    this.audit.log({ action: "ai.project.ask", userId, orgId, resourceType: "project", resourceId: String(projectId) });
    return { ...data, evidence: { totalTasks, done, inProgress, blocked, overdue } };
  }

  async weeklyUpdate(orgId: string, projectId: number, startDate: string | undefined, endDate: string | undefined, userId: string) {
    const now = new Date();
    const endDateObj = endDate ? new Date(endDate) : now;
    const startDateObj = startDate ? new Date(startDate) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const resolvedStart = startDate ?? startDateObj.toISOString().split("T")[0];
    const resolvedEnd = endDate ?? endDateObj.toISOString().split("T")[0];

    const { project, completedTasks, blockedTasks, openRisks, decisions } = await runInTenantTransaction(this.db, async () => {
      const project = await this.assertProject(orgId, projectId);
      const [completedTasks, blockedTasks, openRisks, decisions] = await Promise.all([
        this.db
          .select({ title: tickets.title })
          .from(tickets)
          .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId), eq(tickets.status, "DONE"), isNull(tickets.deletedAt), gte(tickets.updatedAt, startDateObj), lte(tickets.updatedAt, endDateObj)))
          .limit(30),
        this.db
          .select({ title: tickets.title })
          .from(tickets)
          .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId), eq(tickets.status, "BLOCKED"), isNull(tickets.deletedAt)))
          .limit(10),
        this.db
          .select({ title: projectRisks.title, probability: projectRisks.probability, impact: projectRisks.impact })
          .from(projectRisks)
          .where(and(eq(projectRisks.projectId, projectId), eq(projectRisks.orgId, orgId), isNull(projectRisks.deletedAt), ne(projectRisks.status, "closed")))
          .limit(5),
        this.db
          .select({ title: projectDecisions.title, status: projectDecisions.status })
          .from(projectDecisions)
          .where(and(eq(projectDecisions.projectId, projectId), eq(projectDecisions.orgId, orgId), isNull(projectDecisions.deletedAt)))
          .limit(5),
      ]);
      return { project, completedTasks, blockedTasks, openRisks, decisions };
    }, { orgId });

    const dateRange = `${resolvedStart} to ${resolvedEnd}`;
    const { system, user } = weeklyUpdatePrompt({ projectName: project.name, dateRange, completedTasks, blockedTasks, openRisks, decisions });
    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "pm.weekly-update",
      prompt: { system, user, promptKey: "pm.weekly-update", promptVersion: 1 },
      schema: PmWeeklyUpdateOutputSchema,
      tier: "fast",
      maxTokens: 1024,
      charge: true,
    });

    const data = unwrapAiResult(result);
    this.audit.log({ action: "ai.project.weekly-update", userId, orgId, resourceType: "project", resourceId: String(projectId) });
    return { ...data, dateRange: { startDate: resolvedStart, endDate: resolvedEnd }, suggestions: true };
  }

  async changeImpact(orgId: string, projectId: number, userId: string) {
    const { project, openCrs, openRisks, pendingApprovals } = await runInTenantTransaction(this.db, async () => {
      const project = await this.assertProject(orgId, projectId);
      const [openCrs, openRisks, pendingApprovals] = await Promise.all([
        this.db
          .select({ title: changeRequests.title, status: changeRequests.status, timelineImpactDays: changeRequests.timelineImpactDays, budgetImpactCents: changeRequests.budgetImpactCents, impact: changeRequests.impact })
          .from(changeRequests)
          .where(and(eq(changeRequests.projectId, projectId), eq(changeRequests.orgId, orgId), isNull(changeRequests.deletedAt), notInArray(changeRequests.status, ["rejected", "completed"])))
          .limit(20),
        this.db
          .select({ title: projectRisks.title, probability: projectRisks.probability, impact: projectRisks.impact })
          .from(projectRisks)
          .where(and(eq(projectRisks.projectId, projectId), eq(projectRisks.orgId, orgId), isNull(projectRisks.deletedAt), ne(projectRisks.status, "closed")))
          .limit(10),
        this.db
          .select({ title: projectApprovals.title, entityType: projectApprovals.entityType })
          .from(projectApprovals)
          .where(and(eq(projectApprovals.projectId, projectId), eq(projectApprovals.orgId, orgId), isNull(projectApprovals.deletedAt), notInArray(projectApprovals.status, ["approved", "rejected", "cancelled"])))
          .limit(10),
      ]);
      return { project, openCrs, openRisks, pendingApprovals };
    }, { orgId });

    if (openCrs.length === 0 && openRisks.length === 0 && pendingApprovals.length === 0) {
      return {
        headline: "No active changes, risks, or pending approvals",
        scopeImpact: "No open change requests, risks, or approvals found for this project.",
        scheduleImpact: "No schedule impact identified.",
        budgetImpact: "none identified",
        riskSummary: [],
        pendingApprovals: [],
        citations: [],
        evidence: { openChangeRequests: 0, openRisks: 0, pendingApprovals: 0 },
      };
    }

    const { system, user } = changeImpactPrompt({ projectName: project.name, changeRequests: openCrs, openRisks, pendingApprovals });
    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "pm.change-impact",
      prompt: { system, user, promptKey: "pm.change-impact", promptVersion: 1 },
      schema: PmChangeImpactOutputSchema,
      tier: "fast",
      maxTokens: 1024,
      charge: true,
    });

    const data = unwrapAiResult(result);
    this.audit.log({ action: "ai.project.change-impact", userId, orgId, resourceType: "project", resourceId: String(projectId) });
    return { ...data, evidence: { openChangeRequests: openCrs.length, openRisks: openRisks.length, pendingApprovals: pendingApprovals.length } };
  }
}
