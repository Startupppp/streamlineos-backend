import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  modulesCatalog,
  permissions,
  permissionSupportedScopes,
  rolePermissionGrants,
  userDelegationPermissions,
} from "../../db/schema";
import { PERMISSIONS } from "./permissions";
import { buildPermissionCatalogRows } from "./permission-catalog-rows";
import { buildModulesCatalogRows } from "../../common/rbac/modules-catalog-rows";
import { RoleGrantReconcilerService } from "./role-grant-reconciler.service";

type SupportedScope = "all" | "team" | "own";

interface RetiredPermissionClassification {
  deletableKeys: string[];
  retainedKeys: string[];
}

export function classifyRetiredPermissions(
  staleKeys: string[],
  referencedKeys: string[],
): RetiredPermissionClassification {
  const referenced = new Set(referencedKeys);
  return {
    deletableKeys: staleKeys
      .filter((key) => !referenced.has(key))
      .sort(),
    retainedKeys: staleKeys.filter((key) => referenced.has(key)).sort(),
  };
}

@Injectable()
export class PermissionCatalogSyncService implements OnModuleInit {
  private readonly logger = new Logger(PermissionCatalogSyncService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly grantReconciler: RoleGrantReconcilerService,
  ) {}

  /**
   * The reconciler is called from here rather than from its own lifecycle hook
   * because the ordering is the whole point: a grant whose permission key is new
   * in this release violates the foreign key to `permissions.name` until this
   * sync has run, which is why a migration can never place one. A failed sync
   * therefore skips the reconcile instead of reconciling against a stale catalog.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.sync();
    } catch (error) {
      this.logger.error(
        `Permission catalog sync failed — grants for new permission keys will violate the foreign key until this succeeds: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    try {
      await this.grantReconciler.reconcileAllOrganizations();
    } catch (error) {
      this.logger.error(
        `Role grant reconcile failed — organisations seeded before the current role definitions keep the permissions they have: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async sync(options?: { cleanupRetired?: boolean }): Promise<{
    catalogSize: number;
    staleKeys: string[];
    deletedKeys: string[];
    retainedKeys: string[];
  }> {
    if (PERMISSIONS.length === 0) {
      return {
        catalogSize: 0,
        staleKeys: [],
        deletedKeys: [],
        retainedKeys: [],
      };
    }

    await this.db
      .insert(modulesCatalog)
      .values(buildModulesCatalogRows())
      .onConflictDoNothing();

    const catalogModules = new Set(
      (await this.db.select({ moduleKey: modulesCatalog.moduleKey }).from(modulesCatalog).limit(100))
        .map((row) => row.moduleKey),
    );

    await this.db
      .insert(permissions)
      .values(buildPermissionCatalogRows(catalogModules))
      .onConflictDoUpdate({
        target: permissions.name,
        set: {
          resource: sqlExcluded("resource"),
          action: sqlExcluded("action"),
          description: sqlExcluded("description"),
          moduleKey: sqlExcluded("module_key"),
          administeringModuleKey: sqlExcluded("administering_module_key"),
          isDelegable: sqlExcluded("is_delegable"),
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
    const stored = await this.db.select({ name: permissions.name }).from(permissions).limit(5000);
    const staleKeys = stored
      .map((row) => row.name)
      .filter((name) => !catalogNames.has(name))
      .sort();

    let deletedKeys: string[] = [];
    let retainedKeys = staleKeys;
    if (options?.cleanupRetired === true && staleKeys.length > 0) {
      const cleanup = await this.db.transaction(async (tx) => {
        const lockedRows = await tx
          .select({ name: permissions.name })
          .from(permissions)
          .where(inArray(permissions.name, staleKeys))
          .limit(5000)
          .for("update");
        const lockedKeys = lockedRows.map((row) => row.name);
        const roleReferencedRows = await tx
          .selectDistinct({
            permissionKey: rolePermissionGrants.permissionKey,
          })
          .from(rolePermissionGrants)
          .where(inArray(rolePermissionGrants.permissionKey, lockedKeys));
        const delegationReferencedRows = await tx
          .selectDistinct({
            permissionKey: userDelegationPermissions.permissionKey,
          })
          .from(userDelegationPermissions)
          .where(
            inArray(userDelegationPermissions.permissionKey, lockedKeys),
          );
        const classification = classifyRetiredPermissions(
          lockedKeys,
          [
            ...roleReferencedRows,
            ...delegationReferencedRows,
          ].map((row) => row.permissionKey),
        );
        if (classification.deletableKeys.length > 0) {
          await tx
            .delete(permissions)
            .where(inArray(permissions.name, classification.deletableKeys));
        }
        return classification;
      });
      deletedKeys = cleanup.deletableKeys;
      retainedKeys = cleanup.retainedKeys;
    }

    if (options?.cleanupRetired === true && retainedKeys.length > 0) {
      this.logger.warn(
        `Permission catalog has ${retainedKeys.length} retired key(s) retained because role or delegation grants still reference them: ${retainedKeys.join(", ")}`,
      );
    } else if (staleKeys.length > 0) {
      this.logger.warn(
        `Permission catalog has ${staleKeys.length} retired key(s); cleanup is disabled: ${staleKeys.join(", ")}`,
      );
    }

    return {
      catalogSize: PERMISSIONS.length,
      staleKeys,
      deletedKeys,
      retainedKeys,
    };
  }
}

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
