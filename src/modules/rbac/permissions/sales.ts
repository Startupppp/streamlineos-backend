import { definePermissions } from "./types";

export const SALES_PERMISSIONS = definePermissions([
  {
    name: "sales:view",
    resource: "sales",
    action: "view",
    description: "View sales module",
  },
  {
    name: "sales:manage",
    resource: "sales",
    action: "manage",
    description: "Manage sales module",
  },
]);
