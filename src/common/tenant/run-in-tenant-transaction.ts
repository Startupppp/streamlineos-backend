import type { Db } from "../../db/drizzle.module";
import {
  getTenantContext,
  runWithTenantContext,
  runOutsideTenantContext,
} from "./tenant-context";
import { runOutsidePoolBorrow } from "../../db/pool-telemetry";
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

  if (ambient && ambient.orgId !== explicit.orgId)
    throw new Error(
      `runInTenantTransaction: refusing to open a transaction for org ${explicit.orgId} inside an active transaction for org ${ambient.orgId}.`,
    );

  if (ambient) return fn(ambient.tx);

  const audience = explicit.audience ?? "INTERNAL";
  return withTenant(db, { orgId: explicit.orgId, audience }, (tx) =>
    runWithTenantContext({ orgId: explicit.orgId, audience, tx }, () => fn(tx)),
  );
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
    runOutsideTenantContext(() =>
      withTenant(db, { orgId, audience: "INTERNAL" }, (tx) =>
        runWithTenantContext({ orgId, audience: "INTERNAL", tx }, () => fn(tx)),
      ),
    ),
  );
}
