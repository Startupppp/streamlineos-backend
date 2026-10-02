import type { Permission } from "./types";
import { ACCESS_MANAGED_MODULES } from "../../../common/rbac/module-vocabulary";
import type { DelegableModuleId } from "../../../common/rbac/module-registry";

export { ACCESS_MANAGED_MODULES };

export const MODULE_ACCESS_PERMISSIONS: Permission<
  `${DelegableModuleId}:access:${"view" | "manage"}`
>[] =
  ACCESS_MANAGED_MODULES.flatMap((moduleKey) => [
    {
      name: `${moduleKey}:access:view` as const,
      resource: `${moduleKey}:access`,
      action: "view",
      description: `View roles, permissions and assignments for the ${moduleKey} module`,
    },
    {
      name: `${moduleKey}:access:manage` as const,
      resource: `${moduleKey}:access`,
      action: "manage",
      description: `View access administration for the ${moduleKey} module; changing roles, permissions, or assignments additionally requires Module Admin, Module Owner, Org Admin, or Org Owner authority`,
    },
  ]);
