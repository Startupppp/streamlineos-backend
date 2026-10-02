import { definePermissions } from "./types";

export const API_TOKEN_PERMISSIONS = definePermissions([
  {
    name: "settings:api-tokens:read",
    resource: "settings:api-tokens",
    action: "read",
    description: "View personal API tokens",
  },
  {
    name: "settings:api-tokens:write",
    resource: "settings:api-tokens",
    action: "write",
    description: "Create and revoke personal API tokens",
  },
]);
