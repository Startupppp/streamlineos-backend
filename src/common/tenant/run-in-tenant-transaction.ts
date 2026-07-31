import type { Db } from "../../db/drizzle.module";
import { getTenantContext } from "./tenant-context";
import { withTenant, type TenantTx } from "./with-tenant";


export async function runInTenantTransaction<T>(
  db: Db,
  fn: (tx: TenantTx) => Promise<T>,
  explicit?: { orgId: string; audience?: "INTERNAL" | "PORTAL" },
): Promise<T> {
  const ambient = getTenantContext();

  if (!explicit?.orgId) {
    if (ambient) return fn(ambient.tx);
    throw new Error(
      "runInTenantTransaction: no ambient tenant context. Background jobs must pass an explicit orgId — a query with no tenant GUC will be denied once RLS policies are enabled.",
    );
  }

  if (ambient && ambient.orgId !== explicit.orgId) {
    throw new Error(
      `runInTenantTransaction: refusing to open a transaction for org ${explicit.orgId} inside an active transaction for org ${ambient.orgId}.`,
    );
  }

  if (ambient) return fn(ambient.tx);

  return withTenant(db, { orgId: explicit.orgId, audience: explicit.audience ?? "INTERNAL" }, fn);
}
