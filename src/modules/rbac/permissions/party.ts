import type { Permission } from "./types";

export const PARTY_PERMISSIONS: Permission[] = [
  {
    name: "party:parties:view",
    resource: "party:parties",
    action: "view",
    description: "View business parties (customers, vendors, partners)",
  },
  {
    name: "party:parties:create",
    resource: "party:parties",
    action: "create",
    description: "Create business parties",
  },
  {
    name: "party:parties:update",
    resource: "party:parties",
    action: "update",
    description: "Update business parties",
  },
  {
    name: "party:parties:delete",
    resource: "party:parties",
    action: "delete",
    description: "Soft-delete business parties",
  },
  {
    name: "party:contacts:view",
    resource: "party:contacts",
    action: "view",
    description: "View contacts linked to a business party",
  },
  {
    name: "party:contacts:manage",
    resource: "party:contacts",
    action: "manage",
    description: "Create, update, and delete contacts for a business party",
  },
];
