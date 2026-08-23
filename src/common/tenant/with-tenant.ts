import { sql, type SQL } from "drizzle-orm";
import type { Db, TenantTx } from "../../db/drizzle.types";
import { withPoolBorrow } from "../../db/pool-telemetry";
import { resolveTransactionGuards } from "../../db/pool.config";
import type { TenantAudience } from "./tenant-context";
import { getRegionRegistry, hasRegionRegistry } from "../region/region-registry";

export type { TenantTx };

function buildGuardSettings(): SQL[] {
  const guards = resolveTransactionGuards(process.env);
  const settings: SQL[] = [];

  if (guards.statementTimeoutMs > 0)
    settings.push(sql`set_config('statement_timeout', ${String(guards.statementTimeoutMs)}, true)`);
  if (guards.idleInTransactionMs > 0)
    settings.push(
      sql`set_config('idle_in_transaction_session_timeout', ${String(guards.idleInTransactionMs)}, true)`,
    );
  if (guards.lockTimeoutMs > 0)
    settings.push(sql`set_config('lock_timeout', ${String(guards.lockTimeoutMs)}, true)`);

  return settings;
}

const GUARD_SETTINGS = buildGuardSettings();


/**
 * Picks the connection for the organisation's region.
 *
 * This lives inside `withTenant` rather than at its callers because there are
 * only three of them today — the request interceptor, the background-job
 * helpers, and the cron sweep — and a fourth added later would otherwise reach
 * the wrong database with nothing to catch it. Resolution here is a property of
 * opening a tenant transaction, not something a caller can forget.
 *
 * Falls back to the given connection only when no registry is configured, which
 * is the unit-test path: `RegionModule` is global and eager, so a booted
 * application always has one, and `RegionModule.onApplicationBootstrap` refuses
 * to serve traffic otherwise.
 */
async function resolveRegionalDb(db: Db, orgId: string): Promise<Db> {
  if (!hasRegionRegistry()) return db;
  return getRegionRegistry().dbForOrg(orgId);
}

/**
 * Runs `fn` inside a transaction whose tenant GUCs are set for its duration, and
 * is therefore also where a pooled connection is borrowed for a request's
 * lifetime — so both the borrow and the timeouts bounding it belong here. Neon's
 * pooler drops those timeouts when sent as startup parameters, and `is_local`
 * reverts them at COMMIT before the connection serves the next tenant.
 */
export async function withTenant<T>(
  db: Db,
  context: { orgId: string; audience: TenantAudience },
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!context.orgId)
    throw new Error("withTenant: orgId must be a non-empty string");

  const regional = await resolveRegionalDb(db, context.orgId);

  const settings = sql.join(
    [
      sql`set_config('app.organization_id', ${context.orgId}, true)`,
      sql`set_config('app.audience', ${context.audience}, true)`,
      ...GUARD_SETTINGS,
    ],
    sql`, `,
  );

  return withPoolBorrow((borrow) =>
    regional.transaction(async (tx) => {
      borrow.acquired();
      await tx.execute(sql`SELECT ${settings}`);
      return fn(tx);
    }),
  );
}
