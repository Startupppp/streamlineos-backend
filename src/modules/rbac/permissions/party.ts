import { definePermissions } from "./types";

export const PARTY_PERMISSIONS = definePermissions([
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
  {
    name: "party:roles:manage",
    resource: "party:roles",
    action: "manage",
    description: "Assign and remove the roles a party holds",
  },
  {
    name: "party:duplicates:view",
    resource: "party:duplicates",
    action: "view",
    description: "See parties the system believes may be the same organisation",
  },
  {
    name: "party:merges:manage",
    resource: "party:merges",
    action: "manage",
    description: "Merge two parties, and reverse a merge",
  },
  /*
    `party:divergence:view` was here and went with `GET /party/mirror/divergence`.

    The route reported which legacy CRM rows disagreed with the party they
    mirrored. Ticket 08 dropped those rows, so the report could only ever answer
    zero and the route was removed. A permission gating nothing is a capability
    the catalogue advertises and no code honours.

    Migration 0244's grants are deliberately left in the database. Removing it
    here makes it a retired key, which `PermissionCatalogSyncService` already
    knows how to carry -- it logs the key and leaves the grants alone rather than
    deleting rows. That is the platform's own path for this, and it is safer than
    a migration that deletes grants for a key nothing checks.
  */
  {
    name: "party:subjects:view",
    resource: "party:subjects",
    action: "view",
    description: "View the things the business transacts, and their declared types",
  },
  {
    name: "party:subjects:manage",
    resource: "party:subjects",
    action: "manage",
    description: "Create, update and delete subjects, and link them to parties",
  },
  {
    // Separate from managing records: changing a declaration reshapes every
    // record of that type, which is a different act from editing one of them.
    name: "party:subject-types:manage",
    resource: "party:subject-types",
    action: "manage",
    description: "Declare and change the subject types the organisation transacts",
  },
]);
