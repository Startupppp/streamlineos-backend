import { sql, type SQL } from "drizzle-orm";
import type { Db, TenantTx } from "../../db/drizzle.types";
import { withPoolBorrow } from "../../db/pool-telemetry";
import { resolveTransactionGuards } from "../../db/pool.config";
import type { TenantAudience } from "./tenant-context";

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

  const settings = sql.join(
    [
      sql`set_config('app.organization_id', ${context.orgId}, true)`,
      sql`set_config('app.audience', ${context.audience}, true)`,
      ...GUARD_SETTINGS,
    ],
    sql`, `,
  );

  return withPoolBorrow((borrow) =>
    db.transaction(async (tx) => {
      borrow.acquired();
      await tx.execute(sql`SELECT ${settings}`);
      return fn(tx);
    }),
  );
}
