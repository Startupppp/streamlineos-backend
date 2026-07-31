import type { Permission } from "./types";

export const ACCESS_MANAGED_MODULES = [
  "hr",
  "crm",
  "build",
  "accounting",
  "inventory",
  "support",
  "surveys",
  "payroll",
  "sign",
  "timesheets",
] as const;

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
      description: `Manage roles, permissions and assignments for the ${moduleKey} module`,
    },
  ]);
