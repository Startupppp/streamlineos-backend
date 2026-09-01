import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, lt } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { forEachOrg } from "../../../common/tenant/for-each-org";
import { workflowExecutions } from "../../../db/schema";
import {
  NODE_DISPATCH_PORT,
  type NodeDispatchPort,
  type ResolvedPermissionSet,
} from "./node-outcome";
import {
  isDue,
  readRunState,
  writeRunState,
  type WorkflowRunState,
} from "./workflow-execution-context";
import { claimExecution } from "./execution-claim";
import {
  advanceExecution,
  finishExecution,
  MAX_STEPS_PER_EXECUTION,
} from "./execution-advance";
import { backoffMs } from "../../../common/workflow/retry-policy";
import { OUTBOX_MAX_RETRIES } from "../../../common/outbox/outbox-envelope";
import { AccessService } from "../../access/access.service";

export { MAX_STEPS_PER_EXECUTION };

export const RUNNING_TIMEOUT_MS = 15 * 60 * 1000;
const SWEEP_BATCH = 50;

/**
 * ioredis and postgres-js errors are cross-realm — `instanceof Error` is false.
 * Classify on string properties (`error.code`, `error.name`) instead.
 */
const TRANSIENT_INFRA_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNABORTED",
  "EPIPE",
]);

export function isTransientInfraError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as Record<string, unknown>;
  if (typeof e["code"] === "string" && TRANSIENT_INFRA_CODES.has(e["code"])) return true;
  if (e["name"] === "MaxRetriesPerRequestError") return true;
  return false;
}

async function releaseToWaiting(
  db: Db,
  orgId: string,
  executionId: string,
  runAfter: Date,
  currentState: WorkflowRunState,
): Promise<void> {
  const nextState = writeRunState({
    ...currentState,
    resumeAt: runAfter,
    infraAttempt: currentState.infraAttempt + 1,
  });
  await runInNewTenantTransaction(db, orgId, async (tx) => {
    await tx
      .update(workflowExecutions)
      .set({ status: "waiting", context: nextState })
      .where(
        and(
          eq(workflowExecutions.id, executionId),
          eq(workflowExecutions.orgId, orgId),
          eq(workflowExecutions.status, "running"),
        ),
      );
  });
}

export interface WorkflowSweepResult {
  claimed: number;
  completed: number;
  failed: number;
  suspended: number;
}

@Injectable()
export class WorkflowRunnerService {
  private readonly logger = new Logger(WorkflowRunnerService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(NODE_DISPATCH_PORT) private readonly dispatcher: NodeDispatchPort,
    private readonly access: AccessService,
  ) {}

  async sweep(): Promise<WorkflowSweepResult> {
    const totals: WorkflowSweepResult = {
      claimed: 0,
      completed: 0,
      failed: 0,
      suspended: 0,
    };

    await forEachOrg(this.db, "workflow-runner", async (tx, orgId) => {
      await this.expireStuck(tx, orgId);
      const ids = await this.findRunnableIds(tx, orgId);
      for (const id of ids) {
        const result = await this.runOne(orgId, id);
        if (result === null) continue;
        totals.claimed += 1;
        if (result === "completed") totals.completed += 1;
        else if (result === "failed") totals.failed += 1;
        else totals.suspended += 1;
      }
    });

    return totals;
  }

  private async expireStuck(tx: TenantTx, orgId: string): Promise<void> {
    const cutoff = new Date(Date.now() - RUNNING_TIMEOUT_MS);
    await tx
      .update(workflowExecutions)
      .set({ status: "timed_out", completedAt: new Date() })
      .where(
        and(
          eq(workflowExecutions.orgId, orgId),
          eq(workflowExecutions.status, "running"),
          lt(workflowExecutions.startedAt, cutoff),
        ),
      );
  }

  private async findRunnableIds(tx: TenantTx, orgId: string): Promise<string[]> {
    const rows = await tx
      .select({
        id: workflowExecutions.id,
        status: workflowExecutions.status,
        context: workflowExecutions.context,
      })
      .from(workflowExecutions)
      .where(
        and(
          eq(workflowExecutions.orgId, orgId),
          inArray(workflowExecutions.status, ["pending", "waiting"]),
        ),
      )
      .limit(SWEEP_BATCH);

    const now = new Date();
    return rows
      .filter(
        (row) =>
          row.status === "pending" || isDue(readRunState(row.context), now),
      )
      .map((row) => row.id);
  }

  private async runOne(
    orgId: string,
    executionId: string,
  ): Promise<"completed" | "failed" | "suspended" | null> {
    const execution = await claimExecution(this.db, orgId, executionId);
    if (!execution) return null;

    const currentState = readRunState(execution.context);
    let resolvedPermissions: ResolvedPermissionSet = null;

    if (execution.triggeredBy) {
      try {
        resolvedPermissions = await this.access.resolveUserPermissions(orgId, execution.triggeredBy);
      } catch (error) {
        if (isTransientInfraError(error) && currentState.infraAttempt < OUTBOX_MAX_RETRIES) {
          const delay = backoffMs(currentState.infraAttempt + 1);
          const runAfter = new Date(Date.now() + delay);
          this.logger.warn(
            `workflow execution ${executionId} transient infra error ` +
            `(attempt ${currentState.infraAttempt + 1}/${OUTBOX_MAX_RETRIES}) — ` +
            `code=${String((error as Record<string, unknown>)["code"] ?? "n/a")} ` +
            `name=${String((error as Record<string, unknown>)["name"] ?? "n/a")}; ` +
            `rescheduled in ${delay}ms`,
          );
          await releaseToWaiting(this.db, orgId, executionId, runAfter, currentState);
          return "suspended";
        }
        const errProp = error as Record<string, unknown>;
        const errStr = typeof errProp["message"] === "string"
          ? errProp["message"]
          : typeof errProp["code"] === "string"
          ? errProp["code"]
          : "unknown";
        this.logger.error(
          `workflow execution ${executionId} failed during permission resolve ` +
          `(infraAttempt=${currentState.infraAttempt}): ${errStr}`,
        );
        await runInNewTenantTransaction(this.db, orgId, (tx) =>
          finishExecution(tx, execution.id, "failed"),
        );
        return "failed";
      }
    }

    try {
      return await runInNewTenantTransaction(this.db, orgId, (tx) =>
        advanceExecution(tx, execution, this.dispatcher, resolvedPermissions),
      );
    } catch (error) {
      this.logger.error(
        `workflow execution ${executionId} crashed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await runInNewTenantTransaction(this.db, orgId, (tx) =>
        finishExecution(tx, execution.id, "failed"),
      );
      return "failed";
    }
  }
}

export type { WorkflowRunState };
