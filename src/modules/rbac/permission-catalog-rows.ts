import { administeringModuleOf } from "../../common/rbac/module-vocabulary";
import { isDelegablePermission } from "../../common/rbac/grantability";
import { PERMISSIONS } from "./permissions";

export interface PermissionCatalogRow {
  name: string;
  resource: string;
  action: string;
  description: string | null;
  moduleKey: string;
  administeringModuleKey: string | null;
  isDelegable: boolean;
}

export function buildPermissionCatalogRows(
  catalogModules: ReadonlySet<string>,
): PermissionCatalogRow[] {
  return PERMISSIONS.map((permission) => {
    const administering = administeringModuleOf(permission.name);
    return {
      name: permission.name,
      resource: permission.resource,
      action: permission.action,
      description: permission.description ?? null,
      moduleKey: administering,
      administeringModuleKey: catalogModules.has(administering) ? administering : null,
      isDelegable: isDelegablePermission(permission.name),
    };
  });
}
