import type { Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";

/**
 * Runs `read` in a tenant transaction that **commits before it returns**, so the
 * pooled connection is back in the pool before the caller talks to an AI
 * provider.
 *
 * This is the inventory twin of `timesheets-ai-invoke.ts`'s `readEvidence`, and
 * it only does anything when the route carries `@NoTenantTransaction()`:
 * `runInTenantTransaction` REUSES an ambient request transaction rather than
 * opening a short one (`common/tenant/run-in-tenant-transaction.ts:73`), so
 * wrapping a read without the decorator changes nothing at all. The decorator is
 * what makes the transaction short; this helper is what makes it exist.
 *
 * `db` is the tenant-aware `DRIZZLE` proxy, so every delegate service reached
 * inside `read` — `WarehouseScopeService`, `InvReportsService`,
 * `DemandBaselineService`, the copilot tools — picks up this transaction's GUC
 * through its own `this.db` with no signature change.
 */
export function readEvidence<T>(db: Db, orgId: string, read: () => Promise<T>): Promise<T> {
  return runInTenantTransaction(db, read, { orgId });
}
