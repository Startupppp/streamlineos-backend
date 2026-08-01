import { sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import type { TenantTx } from "./with-tenant";

/**
 * Runs `fn` in a transaction carrying only the authenticated principal, with no
 * tenant GUC.
 *
 * Sign-in has an ordering problem that a tenant context cannot solve: the query
 * that reads `organization_members` is how the org is CHOSEN, so it necessarily
 * runs before any org is known. Its security boundary is the user, not the org.
 * This sets `app.user_id` so the `organization_members` policy can admit the
 * caller's own rows and nothing else.
 *
 * Use ONLY for the pre-tenant identity phase. Once an org is resolved, every
 * subsequent query belongs in `withTenant`.
 */
export async function withIdentity<T>(
  db: Db,
  userId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!userId) {
    throw new Error("withIdentity: userId must be a non-empty string");
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
