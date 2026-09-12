/**
 * Inventory enums that exist only behind a vertical pack.
 *
 * The pharmacy pack's drug schedules, and the materials pack's facility types,
 * material families and construction project/requirement lifecycles. They are
 * grouped because they share a precondition rather than a subject: an
 * organisation without the pack never stores a value from any of them.
 *
 * Split out of `enums.ts` verbatim and re-exported from it, which stays the
 * import path every caller uses.
 */

import { pgEnum } from "drizzle-orm/pg-core";

/**
 * E3 — the schedule a medicine is sold under, behind the `pharmacy` pack.
 *
 * Recorded because it decides what a counter is allowed to do, not because
 * inventory files anything: Schedule H and H1 need a prescription, H1 and X
 * additionally need an entry in a bound register, and narcotics are counted and
 * reconciled separately. `OTC` is stated rather than left as NULL where the
 * organisation has actually classified the SKU — "over the counter" and "nobody
 * has looked at this yet" are different facts, and only the second is a reason
 * to stop a dispense and ask.
 *
 * Deliberately not a jurisdiction-neutral abstraction. These are the Indian
 * Drugs and Cosmetics Rules schedules, and a set that pretended otherwise would
 * be a set nobody could map their labels onto.
 */
export const invDrugScheduleEnum = pgEnum("inv_drug_schedule", [
  "OTC", "H", "H1", "X", "NARCOTIC",
]);

/**
 * B1 — what kind of facility this is, behind the `materials` pack.
 *
 * A dark store is a warehouse that never sees a customer: it exists to be picked
 * from inside a delivery promise measured in minutes. The distinction is
 * operational, not cosmetic — a stockout at a dark store fails an order somebody
 * is waiting on, a stockout at the mother warehouse fails a replenishment run
 * days away, and the two belong in different queues.
 */
export const invFacilityTypeEnum = pgEnum("inv_facility_type", [
  "DARK_STORE",
  "WAREHOUSE",
  "YARD",
  "SITE_STORE",
]);

/**
 * B1 — the material families a construction and interiors catalogue splits on.
 *
 * Wider than `inv_categories`, which is the tenant's own tree and may be
 * anything, and narrower than free text: the family is what reorder grouping and
 * substitution suggestions key on, so it has to be a closed set.
 */
export const invMaterialFamilyEnum = pgEnum("inv_material_family", [
  "CEMENT_AGGREGATE",
  "STEEL_REBAR",
  "BRICK_BLOCK",
  "TILE_STONE",
  "PAINT_COATING",
  "PLUMBING",
  "ELECTRICAL",
  "SANITARYWARE",
  "WOOD_PANEL",
  "GLASS_MIRROR",
  "HARDWARE_FASTENER",
  "ADHESIVE_CHEMICAL",
  "FALSE_CEILING",
  "LIGHTING",
  "OTHER",
]);

/**
 * B1 — a construction project's life, from the site office's point of view.
 *
 * `ON_HOLD` is kept separate from `CANCELLED` because held material stays
 * reserved and cancelled material must be released; the two cannot share a label
 * without one of those behaviours becoming wrong.
 */
export const invProjectStatusEnum = pgEnum("inv_project_status", [
  "PLANNING",
  "ACTIVE",
  "ON_HOLD",
  "COMPLETED",
  "CANCELLED",
]);

/**
 * B1 — what a single material requirement on a project is waiting for.
 *
 * There is no `AT_RISK` label: at-risk is derived from the required-by date, the
 * lead time and what is actually reserved, and a stored flag would go stale the
 * moment either moved.
 */
export const invRequirementStatusEnum = pgEnum("inv_requirement_status", [
  "DRAFT",
  "REQUESTED",
  "RESERVED",
  "PARTIALLY_FULFILLED",
  "FULFILLED",
  "CANCELLED",
]);
