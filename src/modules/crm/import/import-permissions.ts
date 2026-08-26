import type { ImportEntity } from "./import-entities";

/**
 * What an import is allowed to write, on top of being allowed to import.
 *
 * `crm:imports:manage` authorises running an import. It used to be the whole
 * story because an import could only ever write parties; now one file can write
 * subjects, deals or activities, and a single key standing for all four is a
 * bulk-write path into most of the CRM.
 *
 * That costs nothing for the roles that actually do imports: the only roles
 * holding `crm:imports:manage` are `CRM_MODULE_OWNER` and `CRM_MODULE_ADMIN`,
 * and both hold every key below — `party:` included, because `MODULE_REGISTRY`
 * gives the CRM module `administersNamespaces: ["party"]` precisely so a CRM
 * administrator can manage the customers their deals point at. What it stops is
 * the case nothing else covers: a CUSTOM role granted `crm:imports:manage` à la
 * carte, which without this would be a way to write four tables while holding
 * no permission on any of them.
 *
 * These keys are checked against the caller, not against the endpoint, because
 * `@RequirePermission` is static per route and the entity is a property of the
 * request. Failing one is a `ForbiddenException`: the caller is inside the
 * correct tenant and lacks a permission, which is the one case a 403 is for.
 *
 * Deliberately NOT new keys. Every one of these already exists in the catalogue
 * and is already granted, so there is no backfill to get wrong — and a fresh
 * `crm:imports:<entity>:manage` family would reach nobody in any existing
 * organisation until somebody wrote one, which is the silent-failure shape this
 * repository has been bitten by twice.
 */
export const IMPORT_ENTITY_PERMISSIONS: Readonly<Record<ImportEntity, string>> = {
  party: "party:parties:create",
  subject: "party:subjects:manage",
  pipeline: "crm:deals:create",
  activity: "crm:activities:manage",
};

/** The key that authorises running an import at all, whatever it writes. */
export const IMPORT_PERMISSION = "crm:imports:manage";
