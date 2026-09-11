import { sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import {
  getTenantContext,
  runWithTenantContext,
  runOutsideTenantContext,
  type AfterCommitHook,
  type TenantAudience,
} from "./tenant-context";
import { runOutsidePoolBorrow } from "../../db/pool-telemetry";
import { withTenant, type TenantTx } from "./with-tenant";
import { logger } from "../logger/logger.service";
import { bindObservabilityContext, reportError } from "../observability";
import { runAfterCommitWork } from "../observability/after-commit-work";

// Each hook gets its own transaction: the one it was registered in has already committed.
export function drainAfterCommitHooks(
  db: Db,
  orgId: string,
  hooks: readonly AfterCommitHook[],
): void {
  for (const hook of hooks) {
    const run = bindObservabilityContext(() =>
      runInNewTenantTransaction(db, orgId, async () => {
        await hook();
      }),
    );
    void runAfterCommitWork(run).catch((error: unknown) => {
      logger.error(`after-commit hook failed for org ${orgId}`, {
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      reportError(error, { orgId, phase: "after-commit" });
    });
  }
}

// A fresh context must carry an `afterCommit` array or `registerAfterCommit` reports `false` and
// callers that ignore that (most do) lose the work — which is how consumer-emitted notifications
// were committed as intents and never dispatched.
async function openTenantTransaction<T>(
  db: Db,
  orgId: string,
  audience: TenantAudience,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const afterCommit: AfterCommitHook[] = [];
  const result = await withTenant(db, { orgId, audience }, (tx) =>
    runWithTenantContext({ orgId, audience, tx, afterCommit }, () => fn(tx)),
  );
  drainAfterCommitHooks(db, orgId, afterCommit);
  return result;
}

export async function runInTenantTransaction<T>(
  db: Db,
  fn: (tx: TenantTx) => Promise<T>,
  explicit?: { orgId: string; audience?: TenantAudience },
): Promise<T> {
  const ambient = getTenantContext();

  if (!explicit?.orgId) {
    if (ambient) return fn(ambient.tx);
    throw new Error(
      "runInTenantTransaction: no ambient tenant context. Background jobs must pass an explicit orgId — a query with no tenant GUC will be denied once RLS policies are enabled.",
    );
  }

  if (ambient && ambient.orgId !== explicit.orgId)
    throw new Error(
      `runInTenantTransaction: refusing to open a transaction for org ${explicit.orgId} inside an active transaction for org ${ambient.orgId}.`,
    );

  if (ambient) return fn(ambient.tx);

  return openTenantTransaction(db, explicit.orgId, explicit.audience ?? "INTERNAL", fn);
}

export async function runInNewTenantTransaction<T>(
  db: Db,
  orgId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!orgId)
    throw new Error(
      "runInNewTenantTransaction: orgId must be a non-empty string",
    );

  return runOutsidePoolBorrow(() =>
    runOutsideTenantContext(() => openTenantTransaction(db, orgId, "INTERNAL", fn)),
  );
}

export async function runInReplicaTenantRead<T>(
  replicaDb: Db,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const ctx = getTenantContext();
  if (!ctx)
    throw new Error(
      "runInReplicaTenantRead: no ambient tenant context. A replica read without a GUC would fail 42501.",
    );

  return replicaDb.transaction(
    async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.organization_id', ${ctx.orgId}, true), set_config('app.audience', ${ctx.audience}, true)`,
      );
      return fn(tx);
    },
    { accessMode: "read only" },
  );
}
