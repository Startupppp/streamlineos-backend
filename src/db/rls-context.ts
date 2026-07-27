import { sql } from "drizzle-orm";
import type { Db } from "./drizzle.module";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type TenantTx = Tx;

export type Audience = "INTERNAL" | "PORTAL";

export interface TenantContext {
  orgId: string;
  audience: Audience;
  membershipId?: string;
}

export async function withTenant<T>(
  db: Db,
  context: TenantContext,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const { orgId, audience, membershipId } = context;
  if (!orgId) {
    throw new Error("withTenant: orgId must be a non-empty string");
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT
        set_config('app.organization_id',            ${orgId},             true),
        set_config('app.audience',                   ${audience},          true),
        set_config('app.organization_membership_id', ${membershipId ?? ""}, true)`,
    );
    return fn(tx);
  });
}
