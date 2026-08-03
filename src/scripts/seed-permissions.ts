import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PermissionCatalogSyncService } from "../modules/rbac/permission-catalog-sync.service";
import type { Db } from "../db/drizzle.module";

function loadDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return url.trim().replace(/^['"]|['"]$/g, "");
}

async function main(): Promise<void> {
  const client = postgres(loadDatabaseUrl(), { prepare: false, max: 1 });
  const db = drizzle(client) as unknown as Db;

  try {
    const service = new PermissionCatalogSyncService(db);
    const { catalogSize, staleKeys } = await service.sync();

    console.log(`Permission catalog synced: ${catalogSize} key(s).`);
    if (staleKeys.length > 0) {
      console.log(
        `${staleKeys.length} stale key(s) remain in the database and were NOT deleted, ` +
          `because deleting them cascades to role_permission_grants:`,
      );
      for (const key of staleKeys) console.log(`  ${key}`);
    }
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
