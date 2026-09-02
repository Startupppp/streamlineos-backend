import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { organizations } from "../../db/schema";
import { logger } from "../logger/logger.service";
import { runWithTenantContext } from "./tenant-context";
import { withTenant, type TenantTx } from "./with-tenant";
import type { PlacementIntent } from "../region/placement";
import { getRegionRegistry, hasRegionRegistry } from "../region/region-registry";
import {
  getObservabilityContext,
  runWithObservabilityContext,
  type ObservabilityContext,
} from "../observability/observability-context";
import { currentRelease } from "../observability/release";
import { PROCESS_CELL_ID } from "../cell-resources/cell-id";

export interface ForEachOrgResult {
  organizations: number;
  succeeded: number;
  failed: number;
}

/**
 * Returns the db that should be used for the organizations enumeration query.
 *
 * When `CELL_ID` is set on this process, the sweep must only enumerate
 * organizations that live in that cell's database. Without this, a worker
 * started with `CELL_ID=cell-2` takes the cell-2 lease
 * (`cron:lease:cell-2:<job>`) but would iterate organizations from whatever
 * database `db` points at — defeating the isolation the lease intended.
 *
 * Falls back to the caller's `db` when:
 * - `CELL_ID` is not set (single-cell deployment, legacy-1 default)
 * - no RegionRegistry is configured (unit-test path)
 * - `CELL_ID` names a cell that has no matching binding (misconfiguration;
 *   logged as a warning rather than a throw so the sweep degrades gracefully)
 */
function resolveEnumerationDb(fallback: Db): Db {
  const cellId = process.env.CELL_ID;
  if (!cellId || !hasRegionRegistry()) return fallback;

  const registry = getRegionRegistry();
  for (const key of registry.keys) {
    const binding = registry.bindingFor(key);
    if (binding.definition.cell.cellId === cellId) return binding.db;
  }

  logger.warn(
    `[forEachOrg] CELL_ID="${cellId}" matches no region in the registry; ` +
      `using caller's db. This sweep may iterate the wrong cell's organizations.`,
  );
  return fallback;
}

/**
 * The organisation a log line belongs to, stated rather than inherited.
 *
 * A sweep iterates every tenant in one process, so without this every line it
 * emits — and every line emitted by the services it calls — carries the cron
 * trigger's context and no organisation at all, which makes a failure affecting
 * one tenant indistinguishable from one affecting all of them.
 *
 * The correlation id is carried forward from the trigger when there is one, so
 * the whole sweep still joins to the request that started it, and each
 * organisation's slice is separable by `orgId` within it. A sweep with no
 * trigger (a worker calling this directly) gets one id for the run.
 */
function sweepContext(
  sweep: string,
  orgId: string,
  ambient: ObservabilityContext | undefined,
  runId: string,
): ObservabilityContext {
  return {
    ...ambient,
    correlationId: ambient?.correlationId ?? runId,
    orgId,
    route: ambient?.route ?? `sweep:${sweep}`,
    cellId: ambient?.cellId ?? PROCESS_CELL_ID,
    release: ambient?.release ?? currentRelease(),
  };
}

/**
 * Runs a sweep once per organization, each inside its own tenant transaction.
 *
 * Background sweeps used to open with a cross-org discovery query — "every
 * certification expiring this week", across all tenants at once. Under RLS that
 * query has no tenant context and is denied, so discovery has to move inside the
 * per-org loop. `organizations` itself carries no tenant column and therefore no
 * policy, which is what makes enumerating them possible without a bypass role.
 *
 * One organization failing must not abort the rest of the sweep, so each is
 * isolated: its transaction rolls back alone and the loop continues.
 *
 * When `CELL_ID` is set on this process, the enumeration is automatically
 * restricted to that cell's database via `resolveEnumerationDb`. The
 * `withTenant` call already uses the placement-resolved database for each
 * tenant transaction, so the callback always runs against the correct cell.
 */
export async function forEachOrg(
  db: Db,
  sweep: string,
  fn: (tx: TenantTx, orgId: string) => Promise<void>,
  intent: PlacementIntent = "write",
): Promise<ForEachOrgResult> {
  const enumerationDb = resolveEnumerationDb(db);
  // status, not just deletedAt: the purge worker parks an org in PURGE_SCHEDULED/PURGED without soft-deleting it
  const orgs = await enumerationDb
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(isNull(organizations.deletedAt), eq(organizations.status, "ACTIVE")))
    .orderBy(asc(organizations.id));

  let succeeded = 0;
  let failed = 0;
  const ambient = getObservabilityContext();
  const runId = randomUUID();

  for (const org of orgs) {
    // The whole iteration, failure included: the catch's log line is the only
    // signal a sweep produces, and it is worth nothing without naming the tenant
    // at the top level where an aggregator indexes it.
    const ok = await runWithObservabilityContext(
      sweepContext(sweep, org.id, ambient, runId),
      async (): Promise<boolean> => {
        try {
          // The context, not just the transaction: nested services hold the proxied db, not this tx.
          // `withTenant` resolves the correct cell db per org from the registry, so the callback
          // always operates against the cell that owns the organization — regardless of which db
          // was used for enumeration above.
          await withTenant(db, { orgId: org.id, audience: "INTERNAL", intent }, (tx) =>
            runWithTenantContext({ orgId: org.id, audience: "INTERNAL", tx }, () => fn(tx, org.id)),
          );
          return true;
        } catch (err) {
          // Drizzle's message is only "Failed query: <sql> params: <...>" — the reason the
          // statement failed lives on `cause`. Logging the message alone made a sweep that
          // failed for every organization indistinguishable from a connection drop, and cost
          // a wrong diagnosis; the sweep still returns 200, so this log is the only signal.
          const cause = err instanceof Error ? err.cause : undefined;
          logger.error(`[${sweep}] organization sweep failed`, {
            orgId: org.id,
            error: err instanceof Error ? err.message : String(err),
            cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : cause,
            code:
              cause && typeof cause === "object" && "code" in cause
                ? String((cause as { code: unknown }).code)
                : undefined,
          });
          return false;
        }
      },
    );

    if (ok) succeeded += 1;
    else failed += 1;
  }

  return { organizations: orgs.length, succeeded, failed };
}
