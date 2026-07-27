import { withTenant, type TenantTx } from "../../db/rls-context";
import type { Db } from "../../db/drizzle.module";
import { getAmbientTenantContext } from "./tenant-context";

export function runInTenantTransaction<T>(
  db: Db,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const ctx = getAmbientTenantContext();
  if (!ctx) {
    throw new Error(
      "runInTenantTransaction: no ambient tenant context; ensure TenantContextInterceptor is registered as APP_INTERCEPTOR",
    );
  }
  return withTenant(db, ctx, fn);
}
