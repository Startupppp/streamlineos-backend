import { sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import type { TenantTx } from "./with-tenant";

export async function withPublicToken<T>(
  db: Db,
  token: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!token) {
    throw new Error("withPublicToken: token must be a non-empty string");
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.public_token', ${token}, true)`);
    return fn(tx);
  });
}
