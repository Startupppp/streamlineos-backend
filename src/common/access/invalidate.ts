import { type Db } from "../../db/drizzle.module";
import { accessVersions } from "../../db/schema";
import { eq, sql } from "drizzle-orm";

export async function bumpPermissionsVersion(db: Db, orgId: string): Promise<void> {
  await db
    .insert(accessVersions)
    .values({ orgId, permissionsVersion: 1 })
    .onConflictDoUpdate({
      target: accessVersions.orgId,
      set: { permissionsVersion: sql`${accessVersions.permissionsVersion} + 1` },
    });
}
