import { sql } from "drizzle-orm";
import type { Db, TenantTx } from "../../db/drizzle.types";
import type { TenantAudience } from "./tenant-context";

export type { TenantTx };

/** Runs `fn` inside a transaction whose tenant GUCs are set for its duration. */
export async function withTenant<T>(
  db: Db,
  context: { orgId: string; audience: TenantAudience },
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!context.orgId) {
    throw new Error("withTenant: orgId must be a non-empty string");
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT
        set_config('app.organization_id', ${context.orgId}, true),
        set_config('app.audience', ${context.audience}, true)`,
    );
    return fn(tx);
  });
}
