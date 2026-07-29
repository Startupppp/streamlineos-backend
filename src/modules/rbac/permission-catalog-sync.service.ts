import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { permissions, permissionSupportedScopes } from "../../db/schema";
import { PERMISSIONS } from "./permissions";

type SupportedScope = "all" | "team" | "own";

@Injectable()
export class PermissionCatalogSyncService implements OnModuleInit {
  private readonly logger = new Logger(PermissionCatalogSyncService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.sync();
    } catch (error) {
      this.logger.error(
        `Permission catalog sync failed — grants for new permission keys will violate the foreign key until this succeeds: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async sync(): Promise<{ catalogSize: number; staleKeys: string[] }> {
    if (PERMISSIONS.length === 0) return { catalogSize: 0, staleKeys: [] };

    await this.db
      .insert(permissions)
      .values(
        PERMISSIONS.map((permission) => ({
          name: permission.name,
          resource: permission.resource,
          action: permission.action,
          description: permission.description ?? null,
          moduleKey: permission.name.split(":")[0] ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: permissions.name,
        set: {
          resource: sqlExcluded("resource"),
          action: sqlExcluded("action"),
          description: sqlExcluded("description"),
          moduleKey: sqlExcluded("module_key"),
        },
      });

    const scopeRows = PERMISSIONS.flatMap(
      (permission): { permissionKey: string; scope: SupportedScope }[] => {
        const rows: { permissionKey: string; scope: SupportedScope }[] = [
          { permissionKey: permission.name, scope: "all" },
        ];
        if (permission.scopable === true) {
          rows.push({ permissionKey: permission.name, scope: "team" });
          rows.push({ permissionKey: permission.name, scope: "own" });
        }
        return rows;
      },
    );

    await this.db
      .insert(permissionSupportedScopes)
      .values(scopeRows)
      .onConflictDoNothing();

    const catalogNames = new Set(PERMISSIONS.map((permission) => permission.name));
    const stored = await this.db.select({ name: permissions.name }).from(permissions);
    const staleKeys = stored
      .map((row) => row.name)
      .filter((name) => !catalogNames.has(name))
      .sort();

    if (staleKeys.length > 0) {
      this.logger.warn(
        `Permission catalog has ${staleKeys.length} stale key(s) still present in the database and not deleted (deleting them would cascade to role_permission_grants): ${staleKeys.join(", ")}`,
      );
    }

    return { catalogSize: PERMISSIONS.length, staleKeys };
  }
}

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
