import type { Permission } from "./types";
import {
  delegableModuleIds,
  type DelegableModuleId,
} from "../../../common/rbac/module-registry";

/** Computed from the registry: every module whose ladder is delegable. */
export const ACCESS_MANAGED_MODULES: readonly DelegableModuleId[] =
  delegableModuleIds();

export const MODULE_ACCESS_PERMISSIONS: Permission[] =
  ACCESS_MANAGED_MODULES.flatMap((moduleKey) => [
    {
      name: `${moduleKey}:access:view`,
      resource: `${moduleKey}:access`,
      action: "view",
      description: `View roles, permissions and assignments for the ${moduleKey} module`,
    },
    {
      name: `${moduleKey}:access:manage`,
      resource: `${moduleKey}:access`,
      action: "manage",
      description: `View access administration for the ${moduleKey} module; changing roles, permissions, or assignments additionally requires Module Admin, Module Owner, Org Admin, or Org Owner authority`,
    },
  ]);
