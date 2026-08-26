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
 * The one case where the region is *known* rather than looked up.
 *
 * Creating an organisation is a chicken-and-egg the seam did not answer.
 * `withTenant` resolves the region by reading the organisation's row -- correct
 * for every tenant transaction except the one that **writes that row**, where
 * there is nothing to read and `regionForOrg` raises "has no region". Every
 * organisation-creation path in the platform therefore fails once a region
 * registry is active, and none of them noticed: `auth/register` is unreachable
 * from a UI that has no signup page, and the other two are exercised by tests
 * that run without a registry.
 *
 * The information was never missing -- `regionForNewOrg()` decides the placement
 * locally, in the same breath. What was missing was a way to *say* it. That is
 * this: placement passed in, rather than discovered.
 *
 * It cannot be split into "insert the organisation, then open a tenant
 * transaction", which is the obvious fix: `organizations.owner_membership_id` is
 * NOT NULL and carries a DEFERRABLE circular foreign key back to
 * `organization_members`, so the organisation and its first member must commit
 * together or neither is valid.
 *
 * Deliberately narrow. It takes a region rather than accepting an unplaced
 * organisation, so it cannot become a way to reach a tenant's data without
 * knowing where that data lives -- which is the property the whole seam exists
 * to hold.
 */
export async function withNewOrgInRegion<T>(
  db: Db,
  context: { orgId: string; region: string; audience: TenantAudience },
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!context.orgId) throw new Error("withNewOrgInRegion: orgId must be a non-empty string");
  if (!context.region) throw new Error("withNewOrgInRegion: region must be a non-empty string");

  const regional = hasRegionRegistry()
    ? getRegionRegistry().bindingFor(context.region).db
    : db;

  return withTenantOn(regional, { orgId: context.orgId, audience: context.audience }, fn);
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

  return withTenantOn(regional, context, fn);
}

/**
 * `withTenant`'s body, against a connection the caller has already chosen.
 *
 * Split out so that placement-by-lookup and placement-by-declaration share one
 * implementation of the GUCs, the pool borrow and the guard settings -- two
 * copies of that is how one of them quietly stops setting `app.audience`.
 */
async function withTenantOn<T>(
  regional: Db,
  context: { orgId: string; audience: TenantAudience },
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
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
