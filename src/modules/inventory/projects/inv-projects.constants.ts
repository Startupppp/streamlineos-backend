/**
 * The `source_type` string that ties `inv_stock_reservations` back to a project
 * requirement, declared once and imported — a second literal somewhere else is
 * a reservation this module can create and never find again.
 *
 * It lives in its own file rather than in the service because the reservation
 * helpers in `lib/` need it too, and importing it from the service would make
 * the service and its own lib circular.
 */
export const PROJECT_REQUIREMENT_SOURCE = "PROJECT_REQUIREMENT";

/**
 * The status vocabularies and the coverage shape, here for the same reason as
 * the source string above: `lib/project-list.ts` and `lib/project-reads.ts`
 * both need them, and taking them from the service would make the service and
 * its own lib circular — which `check:cycles` fails on even when the import is
 * type-only and compiles away.
 */

/** Statuses that mean the project is still consuming material. */
export const OPEN_PROJECT_STATUSES = ["PLANNING", "ACTIVE", "ON_HOLD"] as const;

/** Statuses that mean the line still wants stock. */
export const OPEN_REQUIREMENT_STATUSES = ["DRAFT", "REQUESTED", "RESERVED", "PARTIALLY_FULFILLED"] as const;
