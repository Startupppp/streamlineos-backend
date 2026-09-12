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
import { withNewOrgInRegion, withTenant, type TenantTx } from "./with-tenant";
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

/**
 * `runInNewTenantTransaction` for the transaction that **creates** an
 * organisation.
 *
 * Identical in every respect but one: the region is declared rather than looked
 * up. `runInNewTenantTransaction` reaches `withTenant`, which asks the registry
 * where the organisation lives — and for the transaction writing the
 * organisation's own row there is nothing to read, so `regionForOrg` raises
 * "has no region" and creation fails on any deployment with a live registry.
 * `withNewOrgInRegion` is the seam's answer to that, and this is how the two
 * remaining creation paths reach it while keeping everything else
 * `runInNewTenantTransaction` does for them.
 *
 * That "everything else" is not decoration:
 *
 *   - `runOutsideTenantContext` so creation is not refused as a nested
 *     transaction when the request already opened one for another organisation.
 *   - `runWithTenantContext` so the `DRIZZLE` proxy routes the body's
 *     `this.db` calls into *this* transaction. `seedSystemRolesForOrg(this.db,
 *     …)` and every other helper taking a `Db` rather than a `tx` depends on it;
 *     without it they issue autocommit statements with no tenant GUC, against
 *     the primary pool, for an organisation that has not committed yet.
 *   - `runOutsidePoolBorrow` so a long provisioning transaction is not counted
 *     against the request's borrow.
 *
 * Calling `withNewOrgInRegion` directly is correct only where the body touches
 * nothing but `tx` — which is true of `auth.register` and of nothing else.
 */
export async function runInNewOrgTransaction<T>(
  db: Db,
  org: { orgId: string; region: string },
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!org.orgId)
    throw new Error("runInNewOrgTransaction: orgId must be a non-empty string");
  if (!org.region)
    throw new Error("runInNewOrgTransaction: region must be a non-empty string");

  const { orgId, region } = org;

  /*
   * Carries an `afterCommit` array and drains it, as `openTenantTransaction` does
   * for every other fresh context: without one `registerAfterCommit` answers
   * `false` and a hook registered while the organisation is being created is
   * silently dropped. The hooks run after this transaction commits, by which
   * point the organisation row exists and `withTenant` can look its region up.
   */
  return runOutsidePoolBorrow(() =>
    runOutsideTenantContext(async () => {
      const afterCommit: AfterCommitHook[] = [];
      const result = await withNewOrgInRegion(
        db,
        { orgId, region, audience: "INTERNAL" },
        (tx) =>
          runWithTenantContext({ orgId, audience: "INTERNAL", tx, afterCommit }, () => fn(tx)),
      );
      drainAfterCommitHooks(db, orgId, afterCommit);
      return result;
    }),
  );
}
