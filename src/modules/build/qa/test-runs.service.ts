import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { bugs, testCases, testRunResults, testRuns, tickets, workItemQaDetails, projectStatuses } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { assertProjectAccess } from "../core/project-access";
import { AuditService } from "../../../common/audit/audit.service";
import { buildIdCursorPage } from "../../../common/pagination/cursor";
import type {
  CreateBugFromResultInput,
  CreateTestRunInput,
  RunResultsQuery,
  UpdateTestResultInput,
  UpdateTestRunInput,
} from "./dto/qa.schemas";
import { resolveWorkItemStatus, resolveTicketPriority } from "./phase-2/bug-consolidation-mapping";

const RUN_PAGE = 50;

@Injectable()
export class TestRunsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async listRuns(
    u: CurrentUserContext,
    projectId: number,
    query: { status?: "not_started" | "in_progress" | "completed" | "aborted"; cursor?: number },
  ) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const conditions = [
      eq(testRuns.orgId, u.orgId),
      eq(testRuns.projectId, projectId),
      isNull(testRuns.deletedAt),
    ];
    if (query.status) conditions.push(eq(testRuns.status, query.status));
    if (query.cursor !== undefined) conditions.push(gt(testRuns.id, query.cursor));
    const rawRuns = await this.db
      .select()
      .from(testRuns)
      .where(and(...conditions))
      .orderBy(testRuns.id)
      .limit(RUN_PAGE + 1);

    const hasMore = rawRuns.length > RUN_PAGE;
    const pageRuns = hasMore ? rawRuns.slice(0, RUN_PAGE) : rawRuns;
    const nextCursor = hasMore && pageRuns.length > 0 ? pageRuns[pageRuns.length - 1]!.id : null;

    if (pageRuns.length === 0) return { data: [], hasMore: false, nextCursor: null };

    const runIds = pageRuns.map((r) => r.id);
    const countRows = await this.db
      .select({
        runId: testRunResults.runId,
        total: count(),
        passed: count(sql`CASE WHEN ${testRunResults.status} = 'passed' THEN 1 END`),
        failed: count(sql`CASE WHEN ${testRunResults.status} = 'failed' THEN 1 END`),
        blocked: count(sql`CASE WHEN ${testRunResults.status} = 'blocked' THEN 1 END`),
        skipped: count(sql`CASE WHEN ${testRunResults.status} = 'skipped' THEN 1 END`),
        notRun: count(sql`CASE WHEN ${testRunResults.status} = 'not_run' THEN 1 END`),
      })
      .from(testRunResults)
      .where(inArray(testRunResults.runId, runIds))
      .groupBy(testRunResults.runId);
    const countMap = new Map(countRows.map((r) => [r.runId, r]));
    const data = pageRuns.map((run) => {
      const s = countMap.get(run.id);
      return {
        ...run,
        passCount: Number(s?.passed ?? 0),
        failCount: Number(s?.failed ?? 0),
        blockedCount: Number(s?.blocked ?? 0),
        notRunCount: Number(s?.notRun ?? 0),
        skippedCount: Number(s?.skipped ?? 0),
      };
    });
    return { data, hasMore, nextCursor };
  }

  async getRun(u: CurrentUserContext, projectId: number, runId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const run = await this.db.query.testRuns.findFirst({
      where: and(
        eq(testRuns.id, runId),
        eq(testRuns.orgId, orgId),
        eq(testRuns.projectId, projectId),
        isNull(testRuns.deletedAt),
      ),
    });
    if (!run) throw new NotFoundException("Test run not found");
    const results = await this.db
      .select({
        id: testRunResults.id,
        runId: testRunResults.runId,
        testCaseId: testRunResults.testCaseId,
        status: testRunResults.status,
        notes: testRunResults.notes,
        executedBy: testRunResults.executedBy,
        executedAt: testRunResults.executedAt,
        linkedBugId: testRunResults.linkedBugId,
        linkedWorkItemId: testRunResults.linkedWorkItemId,
        createdAt: testRunResults.createdAt,
        updatedAt: testRunResults.updatedAt,
        caseNumber: testCases.caseNumber,
        caseTitle: testCases.title,
        casePriority: testCases.priority,
      })
      .from(testRunResults)
      .innerJoin(testCases, eq(testRunResults.testCaseId, testCases.id))
      .where(and(eq(testRunResults.runId, runId), eq(testRunResults.orgId, orgId)))
      .orderBy(testCases.caseNumber);
    return { ...run, results };
  }

  async listRunResults(
    u: CurrentUserContext,
    projectId: number,
    runId: number,
    query: RunResultsQuery,
  ) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const run = await this.db.query.testRuns.findFirst({
      where: and(
        eq(testRuns.id, runId),
        eq(testRuns.orgId, orgId),
        eq(testRuns.projectId, projectId),
        isNull(testRuns.deletedAt),
      ),
      columns: { id: true },
    });
    if (!run) throw new NotFoundException("Test run not found");

    const limit = query.limit ?? 50;
    const conditions = [
      eq(testRunResults.runId, runId),
      eq(testRunResults.orgId, orgId),
    ];
    if (query.cursor !== undefined) conditions.push(gt(testRunResults.id, query.cursor));

    const rows = await this.db
      .select({
        id: testRunResults.id,
        orgId: testRunResults.orgId,
        projectId: testRunResults.projectId,
        runId: testRunResults.runId,
        testCaseId: testRunResults.testCaseId,
        status: testRunResults.status,
        notes: testRunResults.notes,
        executedBy: testRunResults.executedBy,
        executedAt: testRunResults.executedAt,
        linkedBugId: testRunResults.linkedBugId,
        linkedWorkItemId: testRunResults.linkedWorkItemId,
        createdAt: testRunResults.createdAt,
        updatedAt: testRunResults.updatedAt,
      })
      .from(testRunResults)
      .where(and(...conditions))
      .orderBy(testRunResults.id)
      .limit(limit + 1);

    return buildIdCursorPage(rows, limit, (r) => r.id);
  }

  async createRun(u: CurrentUserContext, projectId: number, input: CreateTestRunInput) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${testRuns.runNumber}), 0)` })
        .from(testRuns)
        .where(and(eq(testRuns.projectId, projectId), eq(testRuns.orgId, u.orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      const [created] = await tx
        .insert(testRuns)
        .values({
          orgId: u.orgId,
          projectId,
          runNumber: nextNumber,
          name: input.name,
          sprintId: input.sprintId ?? null,
          releaseId: input.releaseId ?? null,
          environment: input.environment,
          browserDevice: input.browserDevice,
          testerId: input.testerId ?? null,
          createdBy: u.userId,
        })
        .returning();
      let caseIds: number[];
      if (input.caseIds && input.caseIds.length > 0) {
        const validCases = await tx
          .select({ id: testCases.id })
          .from(testCases)
          .where(
            and(
              inArray(testCases.id, input.caseIds),
              eq(testCases.orgId, u.orgId),
              eq(testCases.projectId, projectId),
              isNull(testCases.deletedAt),
            ),
          );
        if (validCases.length !== input.caseIds.length)
          throw new BadRequestException("One or more test case IDs do not belong to this project");
        caseIds = input.caseIds;
      } else if (input.suiteId !== undefined) {
        const rows = await tx
          .select({ id: testCases.id })
          .from(testCases)
          .where(
            and(
              eq(testCases.suiteId, input.suiteId),
              eq(testCases.orgId, u.orgId),
              eq(testCases.projectId, projectId),
              isNull(testCases.deletedAt),
            ),
          );
        caseIds = rows.map((r) => r.id);
      } else {
        const rows = await tx
          .select({ id: testCases.id })
          .from(testCases)
          .where(
            and(
              eq(testCases.orgId, u.orgId),
              eq(testCases.projectId, projectId),
              isNull(testCases.deletedAt),
            ),
          );
        caseIds = rows.map((r) => r.id);
      }
      if (caseIds.length > 0) {
        await tx.insert(testRunResults).values(
          caseIds.map((caseId) => ({
            orgId: u.orgId,
            projectId,
            runId: created.id,
            testCaseId: caseId,
            status: "not_run" as const,
          })),
        );
      }
      return created;
    });
  }

  async updateRun(
    u: CurrentUserContext,
    projectId: number,
    runId: number,
    input: UpdateTestRunInput,
  ) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const userId = u.userId;
    const existing = await this.db.query.testRuns.findFirst({
      where: and(
        eq(testRuns.id, runId),
        eq(testRuns.orgId, orgId),
        eq(testRuns.projectId, projectId),
        isNull(testRuns.deletedAt),
      ),
      columns: { id: true, status: true, startedAt: true, completedAt: true },
    });
    if (!existing) throw new NotFoundException("Test run not found");
    const completing = input.status === "completed" && !existing.completedAt;
    const [updated] = await this.db
      .update(testRuns)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.environment !== undefined && { environment: input.environment }),
        ...(input.browserDevice !== undefined && { browserDevice: input.browserDevice }),
        ...(input.testerId !== undefined && { testerId: input.testerId }),
        ...(input.sprintId !== undefined && { sprintId: input.sprintId }),
        ...(input.releaseId !== undefined && { releaseId: input.releaseId }),
        ...(input.status === "in_progress" && !existing.startedAt && { startedAt: new Date() }),
        ...(completing && { completedAt: new Date() }),
        updatedAt: new Date(),
      })
      .where(and(eq(testRuns.id, runId), eq(testRuns.orgId, orgId), eq(testRuns.projectId, projectId)))
      .returning();
    if (completing) {
      this.audit.log({
        action: "test_run.completed",
        userId,
        orgId,
        resourceType: "test_run",
        resourceId: String(runId),
        metadata: { runId, projectId },
      });
    }
    return updated;
  }

  async deleteRun(u: CurrentUserContext, projectId: number, runId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const existing = await this.db.query.testRuns.findFirst({
      where: and(
        eq(testRuns.id, runId),
        eq(testRuns.orgId, orgId),
        eq(testRuns.projectId, projectId),
        isNull(testRuns.deletedAt),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Test run not found");
    await this.db
      .update(testRuns)
      .set({ deletedAt: new Date() })
      .where(and(eq(testRuns.id, runId), eq(testRuns.orgId, orgId), eq(testRuns.projectId, projectId)));
    return { success: true };
  }

  async updateResult(
    u: CurrentUserContext,
    projectId: number,
    runId: number,
    resultId: number,
    input: UpdateTestResultInput,
  ) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const executorId = u.userId;
    const existing = await this.db.query.testRunResults.findFirst({
      where: and(
        eq(testRunResults.id, resultId),
        eq(testRunResults.runId, runId),
        eq(testRunResults.orgId, orgId),
        eq(testRunResults.projectId, projectId),
      ),
    });
    if (!existing) throw new NotFoundException("Test run result not found");

    if (existing.status === input.status && (existing.notes ?? null) === (input.notes ?? null))
      return existing;

    const [updated] = await this.db
      .update(testRunResults)
      .set({
        status: input.status,
        notes: input.notes,
        executedBy: executorId,
        executedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(testRunResults.id, resultId), eq(testRunResults.orgId, orgId), eq(testRunResults.projectId, projectId)))
      .returning();
    return updated;
  }

  async createBugFromResult(
    u: CurrentUserContext,
    projectId: number,
    runId: number,
    resultId: number,
    input: CreateBugFromResultInput,
  ) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const userId = u.userId;
    const result = await this.db.query.testRunResults.findFirst({
      where: and(
        eq(testRunResults.id, resultId),
        eq(testRunResults.runId, runId),
        eq(testRunResults.orgId, orgId),
        eq(testRunResults.projectId, projectId),
      ),
      columns: { id: true, testCaseId: true },
    });
    if (!result) throw new NotFoundException("Test run result not found");
    const tc = await this.db.query.testCases.findFirst({
      where: and(eq(testCases.id, result.testCaseId), eq(testCases.orgId, orgId)),
      columns: { id: true, title: true, steps: true, expectedResult: true },
    });
    if (!tc) throw new NotFoundException("Test case not found");
    const stepsText =
      tc.steps && tc.steps.length > 0
        ? tc.steps.map((s, i) => `${i + 1}. ${s.action} → Expected: ${s.expected}`).join("\n")
        : undefined;
    const bug = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${bugs.bugNumber}), 0)` })
        .from(bugs)
        .where(and(eq(bugs.projectId, projectId), eq(bugs.orgId, orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      const [created] = await tx
        .insert(bugs)
        .values({
          orgId,
          projectId,
          bugNumber: nextNumber,
          title: input.title ?? `Failed: ${tc.title}`,
          description: input.description,
          severity: input.severity ?? "major",
          priority: input.priority ?? "medium",
          status: "new",
          stepsToReproduce: stepsText,
          expectedResult: input.expectedResult ?? tc.expectedResult ?? null,
          actualResult: input.actualResult,
          environment: input.environment,
          browserDevice: input.browserDevice,
          assigneeMembershipId: undefined,
          reporterId: userId,
          linkedTestCaseId: tc.id,
          createdBy: userId,
        })
        .returning();
      await tx
        .update(testRunResults)
        .set({ linkedBugId: created.id, updatedAt: new Date() })
        .where(and(eq(testRunResults.id, resultId), eq(testRunResults.orgId, orgId)));
      return created;
    });
    this.audit.log({
      action: "bug.created_from_result",
      userId,
      orgId,
      resourceType: "bug",
      resourceId: String(bug.id),
      metadata: { bugId: bug.id, resultId, runId, projectId },
    });
    return bug;
  }

  async createBugFromResultConsolidated(
    u: CurrentUserContext,
    projectId: number,
    runId: number,
    resultId: number,
    input: CreateBugFromResultInput,
  ) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const userId = u.userId;
    const result = await this.db.query.testRunResults.findFirst({
      where: and(
        eq(testRunResults.id, resultId),
        eq(testRunResults.runId, runId),
        eq(testRunResults.orgId, orgId),
        eq(testRunResults.projectId, projectId),
      ),
      columns: { id: true, testCaseId: true },
    });
    if (!result) throw new NotFoundException("Test run result not found");
    const tc = await this.db.query.testCases.findFirst({
      where: and(eq(testCases.id, result.testCaseId), eq(testCases.orgId, orgId)),
      columns: { id: true, title: true, steps: true, expectedResult: true },
    });
    if (!tc) throw new NotFoundException("Test case not found");

    const availableStatuses = await this.db
      .select({ id: projectStatuses.id, name: projectStatuses.name, order: projectStatuses.order, type: projectStatuses.type })
      .from(projectStatuses)
      .where(and(eq(projectStatuses.orgId, orgId), eq(projectStatuses.projectId, projectId)));

    const ticketStatus = resolveWorkItemStatus("new", availableStatuses);
    const ticketPriority = resolveTicketPriority(input.priority);

    const stepsText =
      tc.steps && tc.steps.length > 0
        ? tc.steps.map((s, i) => `${i + 1}. ${s.action} → Expected: ${s.expected}`).join("\n")
        : undefined;

    const ticket = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${tickets.ticketNumber}), 0)` })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)));
      const nextTicketNumber = (maxRow?.maxNum ?? 0) + 1;

      const [created] = await tx
        .insert(tickets)
        .values({
          orgId,
          projectId,
          ticketNumber: nextTicketNumber,
          title: input.title ?? `Failed: ${tc.title}`,
          description: input.description,
          type: "BUG",
          status: ticketStatus,
          priority: ticketPriority,
          reporterId: userId,
        })
        .returning();

      await tx.insert(workItemQaDetails).values({
        orgId,
        workItemId: created.id,
        projectId,
        severity: input.severity ?? "major",
        stepsToReproduce: stepsText,
        expectedResult: input.expectedResult ?? tc.expectedResult ?? null,
        actualResult: input.actualResult,
        environment: input.environment,
        browserDevice: input.browserDevice,
        linkedTestCaseId: tc.id,
        createdByUserId: userId,
      });

      await tx
        .update(testRunResults)
        .set({ linkedWorkItemId: created.id, updatedAt: new Date() })
        .where(and(eq(testRunResults.id, resultId), eq(testRunResults.orgId, orgId)));

      return created;
    });

    this.audit.log({
      action: "bug.created_from_result_consolidated",
      userId,
      orgId,
      resourceType: "ticket",
      resourceId: String(ticket.id),
      metadata: { ticketId: ticket.id, resultId, runId, projectId },
    });
    return ticket;
  }
}
