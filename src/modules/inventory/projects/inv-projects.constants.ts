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
