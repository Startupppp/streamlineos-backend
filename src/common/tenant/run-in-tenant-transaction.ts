import type { Db } from "../../db/drizzle.module";
import { getTenantContext } from "./tenant-context";
import { withTenant, type TenantTx } from "./with-tenant";

/** Runs `fn` on the request's tenant-scoped transaction. */
export function runInTenantTransaction<T>(
  db: Db,
  fn: (tx: TenantTx) => Promise<T>,
  explicit?: { orgId: string; audience?: "INTERNAL" | "PORTAL" },
): Promise<T> {
  const ambient = getTenantContext();
  if (ambient) return fn(ambient.tx);

  if (!explicit?.orgId) {
    throw new Error(
      "runInTenantTransaction: no ambient tenant context. Background jobs must pass an explicit orgId — a query with no tenant GUC will be denied once RLS policies are enabled.",
    );
  }

  return withTenant(db, { orgId: explicit.orgId, audience: explicit.audience ?? "INTERNAL" }, fn);
}
