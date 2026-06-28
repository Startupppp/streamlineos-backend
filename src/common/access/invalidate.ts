import { type Db } from "../../db/drizzle.module";
import type { CacheService } from "../cache/cache.service";
import { accessVersions } from "../../db/schema";
import { eq, sql } from "drizzle-orm";

export async function bumpPermissionsVersion(db: Db, orgId: string, cache?: CacheService): Promise<void> {
  await db
    .insert(accessVersions)
    .values({ orgId, permissionsVersion: 1 })
    .onConflictDoUpdate({
      target: accessVersions.orgId,
      set: { permissionsVersion: sql`${accessVersions.permissionsVersion} + 1` },
    });

  if (cache) {
    await cache.invalidatePattern(`access:bootstrap:${orgId}:*`).catch(() => undefined);
  }
}
