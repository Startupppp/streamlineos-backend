import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PermissionCatalogSyncService } from "../modules/rbac/permission-catalog-sync.service";
import { RoleGrantReconcilerService } from "../modules/rbac/role-grant-reconciler.service";
import { CronLeaseService } from "../modules/cron/cron-lease.service";
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
    const service = new PermissionCatalogSyncService(
      db,
      new RoleGrantReconcilerService(db),
      new CronLeaseService(null),
    );
    const cleanupRetired = process.argv.includes("--cleanup-retired");
    const { catalogSize, staleKeys, deletedKeys, retainedKeys } =
      await service.sync({ cleanupRetired });

    console.log(`Permission catalog synced: ${catalogSize} key(s).`);
    if (deletedKeys.length > 0) {
      console.log(
        `${deletedKeys.length} unreferenced retired key(s) deleted:`,
      );
      for (const key of deletedKeys) console.log(`  ${key}`);
    }
    if (cleanupRetired && retainedKeys.length > 0) {
      console.log(
        `${retainedKeys.length} retired key(s) remain because role or delegation grants reference them:`,
      );
      for (const key of retainedKeys) console.log(`  ${key}`);
    } else if (staleKeys.length > 0 && !cleanupRetired) {
      console.log(
        `${staleKeys.length} retired key(s) detected. Re-run with --cleanup-retired to delete only unreferenced keys.`,
      );
    }
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
