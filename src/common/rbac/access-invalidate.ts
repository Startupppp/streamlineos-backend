import { sql } from "drizzle-orm";
import { accessVersions } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export async function bumpPermissionsVersion(tx: DbOrTx, orgId: string): Promise<void> {
  await tx
    .insert(accessVersions)
    .values({ orgId })
    .onConflictDoUpdate({
      target: accessVersions.orgId,
      set: {
        permissionsVersion: sql`${accessVersions.permissionsVersion} + 1`,
        updatedAt: new Date(),
      },
    });
}
