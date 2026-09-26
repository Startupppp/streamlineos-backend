import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { projectAutomationRuns, projectAutomationRunActions, projectAutomations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ProjectsMembersService } from "./projects-members.service";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";

export type AutomationRunOutcome =
  | "matched_success"
  | "matched_partial_failure"
  | "matched_failed"
  | "not_matched"
  | "blocked_loop_guard"
  | "blocked_rate_limit"
  | "error";

export interface AutomationActionRunResult {
  index: number;
  type: string;
  outcome: "success" | "failure";
  errorMessage: string | null;
}

export interface ListAutomationRunsQuery {
  automationId?: number;
  limit: number;
  cursor?: string;
}

/**
 * Owns the durable Phase 5 automation run history: writing one row per rule
 * evaluation (`recordRun`) and one row per action executed within a matched
 * rule (`recordRunActions`), and reading it back paginated for the operator
 * surface (`listRuns`). Split out of `BuildAutomationRunnerService` so the
 * runner stays focused on execution and this stays focused on the audit
 * trail — BE-09 (file size) and a real seam: nothing here needs to know how
 * conditions are evaluated or actions are executed.
 */
@Injectable()
export class BuildAutomationRunHistoryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly members: ProjectsMembersService,
  ) {}

  /**
   * Best-effort: a failure recording history must never take down the
   * automation run itself, which has already (or is about to) commit real
   * ticket/label/comment writes.
   *
   * When the automation matched and ran (success, partial failure, or full
   * failure), this also stamps `last_run_at` (always on a matched run) and
   * `last_failure_at` (only when the outcome indicates a failure) on the parent
   * `project_automations` row. Unmatched, loop-guard and rate-limit outcomes do
   * not stamp either column — the automation did not execute.
   *
   * This runs inside the after-commit fresh tenant transaction the interceptor
   * drains (see build-automation-runner.service.ts: `registerAfterCommit`), so
   * the tenant GUC is set and the RLS UPDATE is safe.
   */
  async recordRun(params: {
    orgId: string;
    projectId: number;
    automationId: number | null;
    ticketId: number | null;
    triggerEvent: string;
    matched: boolean;
    outcome: AutomationRunOutcome;
    errorMessage: string | null;
  }): Promise<number | null> {
    try {
      const [row] = await this.db
        .insert(projectAutomationRuns)
        .values({
          orgId: params.orgId,
          projectId: params.projectId,
          automationId: params.automationId,
          ticketId: params.ticketId,
          triggerEvent: params.triggerEvent,
          matched: params.matched,
          outcome: params.outcome,
          errorMessage: params.errorMessage,
        })
        .returning({ id: projectAutomationRuns.id });

      if (
        params.automationId !== null &&
        (params.outcome === "matched_success" ||
          params.outcome === "matched_partial_failure" ||
          params.outcome === "matched_failed" ||
          params.outcome === "error")
      ) {
        const now = new Date();
        const stamp =
          params.outcome === "matched_success" || params.outcome === "matched_partial_failure"
            ? { lastRunAt: now }
            : params.outcome === "matched_failed"
              ? { lastRunAt: now, lastFailureAt: now }
              : { lastFailureAt: now };
        await this.db
          .update(projectAutomations)
          .set(stamp)
          .where(
            and(
              eq(projectAutomations.id, params.automationId),
              eq(projectAutomations.orgId, params.orgId),
            ),
          );
      }

      return row?.id ?? null;
    } catch (error) {
      logger.error("BuildAutomationRunHistory: failed to record run history", {
        orgId: params.orgId,
        projectId: params.projectId,
        automationId: params.automationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async recordRunActions(orgId: string, runId: number, results: AutomationActionRunResult[]): Promise<void> {
    if (results.length === 0) return;
    try {
      await this.db.insert(projectAutomationRunActions).values(
        results.map((r) => ({
          orgId,
          runId,
          actionIndex: r.index,
          actionType: r.type,
          outcome: r.outcome,
          errorMessage: r.errorMessage,
        })),
      );
    } catch (error) {
      logger.error("BuildAutomationRunHistory: failed to record run action history", {
        orgId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Cursor-paginated read of run history for a project, optionally narrowed to one automation. BE-24/25. */
  async listRuns(u: CurrentUserContext, projectId: number, query: ListAutomationRunsQuery) {
    await this.members.assertProjectAccess(u, projectId);
    const { limit, cursor, automationId } = query;
    const pos = decodeCursor(cursor);

    const conds = [eq(projectAutomationRuns.orgId, u.orgId), eq(projectAutomationRuns.projectId, projectId)];
    if (automationId !== undefined) conds.push(eq(projectAutomationRuns.automationId, automationId));
    if (pos) conds.push(keysetBeforeId(projectAutomationRuns.createdAt, projectAutomationRuns.id, pos));

    const runCols = {
      id: projectAutomationRuns.id,
      orgId: projectAutomationRuns.orgId,
      projectId: projectAutomationRuns.projectId,
      automationId: projectAutomationRuns.automationId,
      ticketId: projectAutomationRuns.ticketId,
      triggerEvent: projectAutomationRuns.triggerEvent,
      matched: projectAutomationRuns.matched,
      outcome: projectAutomationRuns.outcome,
      errorMessage: projectAutomationRuns.errorMessage,
      createdAt: projectAutomationRuns.createdAt,
    };

    const rows = await this.db
      .select(runCols)
      .from(projectAutomationRuns)
      .where(and(...conds))
      .orderBy(desc(projectAutomationRuns.createdAt), desc(projectAutomationRuns.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (r) => ({
      sortValue: r.createdAt.toISOString(),
      id: String(r.id),
    }));

    // One grouped query for every run on this page rather than one per row (BE-47).
    const runIds = page.data.map((r) => r.id);
    const actionRows = runIds.length === 0
      ? []
      : await this.db
          .select({
            runId: projectAutomationRunActions.runId,
            id: projectAutomationRunActions.id,
            actionIndex: projectAutomationRunActions.actionIndex,
            actionType: projectAutomationRunActions.actionType,
            outcome: projectAutomationRunActions.outcome,
            errorMessage: projectAutomationRunActions.errorMessage,
            createdAt: projectAutomationRunActions.createdAt,
          })
          .from(projectAutomationRunActions)
          .where(and(eq(projectAutomationRunActions.orgId, u.orgId), inArray(projectAutomationRunActions.runId, runIds)));

    const actionsByRun = new Map<number, typeof actionRows>();
    for (const row of actionRows) {
      const list = actionsByRun.get(row.runId) ?? [];
      list.push(row);
      actionsByRun.set(row.runId, list);
    }

    return {
      items: page.data.map((r) => ({ ...r, actions: actionsByRun.get(r.id) ?? [] })),
      pagination: page.pagination,
    };
  }
}
