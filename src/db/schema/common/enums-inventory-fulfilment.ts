/**
 * Inventory enums: the warehouse's execution layer and the channels it serves.
 *
 * Picking, putaway, cycle counting, quality inspection and recall, shipping and
 * loads, handling units, slotting, labour and dock appointments — the states a
 * piece of work passes through, as distinct from the states a SKU or a document
 * is in — together with the sales channels and integration plumbing that feed
 * that work and the platform orders and ASNs that arrive from them.
 *
 * Split out of `enums.ts` verbatim and re-exported from it, which stays the
 * import path every caller uses.
 */

import { pgEnum } from "drizzle-orm/pg-core";

/**
 * INV-205. Why a pick line did not close the way it was asked to.
 *
 * B5 adds `WRONG_LOCATION`, and it is the one member that does not close the
 * line. The other four say the units are not coming: the shelf was short, the
 * bin was empty, the goods were broken, or something else went in the tote.
 * `WRONG_LOCATION` says the goods exist and the wave sent the picker to the
 * wrong place — the work is still outstanding, so the line is retargeted and
 * stays open rather than being written off.
 */
export const invPickExceptionEnum = pgEnum("inv_pick_exception", [
  "SHORT",
  "NOT_FOUND",
  "DAMAGED",
  "SUBSTITUTED",
  "WRONG_LOCATION",
]);
/**
 * B5. Where an exception is in its own life, separately from the line's.
 *
 * An exception nobody has looked at and one a supervisor has signed off are
 * different facts, and the enum on its own could not tell them apart — so a
 * substitution the picker invented at the shelf read exactly like one the
 * warehouse had agreed to.
 */
export const invPickExceptionStatusEnum = pgEnum("inv_pick_exception_status", [
  "OPEN",
  "RESOLVED",
]);
/** B5. What the reviewer decided. Set only when the exception is RESOLVED. */
export const invPickExceptionResolutionEnum = pgEnum("inv_pick_exception_resolution", [
  "ACCEPTED",
  "REJECTED",
]);

export const invPickListStatusEnum = pgEnum("inv_pick_list_status", ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);
/** B3. Where a putaway task is between the receiving dock and the shelf. */
export const invPutawayStatusEnum = pgEnum("inv_putaway_status", ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);
/**
 * B3. Where a putaway line is allowed to end up.
 *
 * `STORAGE` is the ordinary case and the destination is the operator's, chosen
 * from the suggestions. `QUARANTINE` is not a preference: it is set from the
 * quality state of the goods, and the destination is the warehouse's quarantine
 * location whatever the operator scans.
 */
export const invPutawayDispositionEnum = pgEnum("inv_putaway_disposition", ["STORAGE", "QUARANTINE"]);
export const invCycleCountStatusEnum = pgEnum("inv_cycle_count_status", ["PLANNED", "COUNTING", "REVIEW", "POSTED", "CANCELLED"]);
export const invQualityInspectionStatusEnum = pgEnum("inv_quality_inspection_status", ["PENDING", "IN_PROGRESS", "PASSED", "FAILED", "DISPOSITION_REQUIRED", "COMPLETED", "CANCELLED"]);
export const invQualityHoldStatusEnum = pgEnum("inv_quality_hold_status", ["ACTIVE", "RELEASED"]);
export const invQualityDispositionEnum = pgEnum("inv_quality_disposition", ["RELEASE_TO_AVAILABLE", "QUARANTINE", "RETURN_TO_VENDOR", "SCRAP"]);
/**
 * D3. How much of an arriving quantity an inspector has to physically check.
 *
 * It is the *sample*, never the hold: the whole delivered quantity is
 * quarantined pending the verdict whatever the sample size says, because a
 * sample that fails condemns the batch it was drawn from and not just the units
 * that were opened.
 */
export const invInspectionSamplingMethodEnum = pgEnum("inv_inspection_sampling_method", ["ALL", "PERCENTAGE", "FIXED_QUANTITY"]);
/**
 * A plan version is immutable once it leaves DRAFT — an inspection records the
 * version that governed it, so editing that version rewrites the rule a
 * completed result was judged against. Changing a rule publishes a new version
 * and supersedes the old one.
 */
export const invInspectionPlanVersionStatusEnum = pgEnum("inv_inspection_plan_version_status", ["DRAFT", "ACTIVE", "SUPERSEDED"]);
export const invRecallStatusEnum = pgEnum("inv_recall_status", ["OPEN", "IN_PROGRESS", "CLOSED"]);
export const invShipmentStatusEnum = pgEnum("inv_shipment_status", ["DRAFT", "PACKED", "LABEL_CREATED", "SHIPPED", "DELIVERED", "CANCELLED"]);
export const invPackageStatusEnum = pgEnum("inv_package_status", ["OPEN", "CLOSED", "SHIPPED"]);
export const invLoadStatusEnum = pgEnum("inv_load_status", ["DRAFT", "DISPATCHED", "ARRIVED", "CLOSED", "CANCELLED"]);
export const invChannelTypeEnum = pgEnum("inv_channel_type", ["INTERNAL", "SHOPIFY", "WOOCOMMERCE", "MARKETPLACE", "B2B", "THREE_PL"]);
export const invChannelStatusEnum = pgEnum("inv_channel_status", ["ACTIVE", "PAUSED"]);
export const invChannelPubStatusEnum = pgEnum("inv_channel_pub_status", ["PENDING", "PUBLISHED", "FAILED"]);
export const inv3plStatusEnum = pgEnum("inv_3pl_status", ["DISCONNECTED", "CONNECTED", "ERROR"]);

/**
 * E6 — the lifecycle of one inbound delivery from a sales channel.
 *
 * `PENDING` is "received and acknowledged, not yet refetched": the delivery row
 * *is* the queue, so a delivery that arrives while the drain is down is not
 * lost. `DEAD` is one whose refetch failed its whole ladder — kept rather than
 * deleted, because "the marketplace told us something and we never looked" is
 * exactly the fact an operator needs to see.
 */
export const invChannelDeliveryStatusEnum = pgEnum("inv_channel_delivery_status", ["PENDING", "PROCESSED", "FAILED", "DEAD"]);
export const invChannelSnapshotDiffStatusEnum = pgEnum("inv_channel_snapshot_diff_status", ["OPEN", "ACCEPTED", "DISMISSED"]);

/**
 * E6 — what an organisation has decided may happen when a channel disagrees
 * with the ledger.
 *
 * `RECORD_DIFFERENCE` is the default and does exactly what it says. It is not a
 * degraded mode: a marketplace's stock figure is that marketplace's opinion
 * about our warehouse, and an opinion that could post a movement would make the
 * ledger a mirror of whichever system last spoke.
 *
 * `ALLOW_ADJUSTMENT` does **not** mean the snapshot writes the ledger. It means
 * a named operator is permitted to accept a recorded difference, which then
 * posts one ordinary stock-engine command under their own idempotency key and
 * warehouse scope — the same path a manual adjustment takes.
 */
export const invChannelSnapshotPolicyEnum = pgEnum("inv_channel_snapshot_policy", ["RECORD_DIFFERENCE", "ALLOW_ADJUSTMENT"]);

/**
 * INV-27 — which of the five things a channel job is.
 *
 * The split between `ORDER_PULL` and `ORDER_IMPORT` is the one a reader should
 * not skim. A pull is one conversation with the marketplace: "what orders do
 * you have". An import is one *order* becoming one of ours, keyed on the
 * channel's own order id, and it is a separate row precisely so that the key
 * exists in the database. Collapsing them would put idempotency back into the
 * worker's memory, where a crash between "fetched" and "created" loses it — and
 * the failure that costs is a duplicate sales order for a customer who ordered
 * once.
 *
 * `STOCK_PUSH` and `STOCK_PULL` are likewise two rows, not one round trip: a
 * push that succeeds and a pull that times out must not report as one failure,
 * because retrying the pair would re-push a figure the channel already took.
 */
export const invChannelJobKindEnum = pgEnum("inv_channel_job_kind", [
  "STOCK_PUSH",
  "STOCK_PULL",
  "ORDER_PULL",
  "ORDER_IMPORT",
  "SHIP_CONFIRM",
]);
export const invIdempotencyStatusEnum = pgEnum("inv_idempotency_status", ["IN_FLIGHT", "COMPLETED", "FAILED"]);
export const invJobStatusEnum = pgEnum("inv_job_status", ["PENDING", "VALIDATING", "RUNNING", "COMPLETED", "FAILED"]);

/** Per-row outcome, so a resumed import skips what already applied. */
export const invImportRowStatusEnum = pgEnum("inv_import_row_status", ["PENDING", "APPLIED", "FAILED", "SKIPPED"]);
export const invWebhookEventStatusEnum = pgEnum("inv_webhook_event_status", ["PENDING", "DELIVERED", "FAILED"]);

/**
 * NEO-2 — the quick-commerce networks a seller receives purchase orders from.
 *
 * These are *inbound* platforms: Streamline is the brand's system, and Blinkit,
 * Instamart and Zepto each run their own dark-store WMS. What crosses the
 * boundary is a purchase order and an advance shipping notice, never stock.
 */
export const invQcProviderEnum = pgEnum("inv_qc_provider", ["BLINKIT", "INSTAMART", "ZEPTO"]);

/** NEO-2. Where an ingested platform purchase order stands. */
export const invPlatformPoStatusEnum = pgEnum("inv_platform_po_status", [
  "RECEIVED",
  "REJECTED",
  "ACCEPTED",
  "CANCELLED",
]);

/** NEO-2. An advance shipping notice's life, from raised to received. */
export const invAsnStatusEnum = pgEnum("inv_asn_status", [
  "DRAFT",
  "CONFIRMED",
  "IN_TRANSIT",
  "ARRIVED",
  "CLOSED",
  "CANCELLED",
]);

/**
 * NEO-4 - what kind of thing the label is stuck to. Descriptive only: the engine
 * treats every kind identically, and the distinction is for the floor and for
 * carrier paperwork.
 */
export const invHandlingUnitKindEnum = pgEnum("inv_handling_unit_kind", [
  "PALLET",
  "CARTON",
  "CAGE",
  "TOTE",
]);

/**
 * NEO-4 - a handling unit's life.
 *
 * `OPEN` accepts more stock; `CLOSED` is built and may still be moved or picked
 * from; `SHIPPED` has left; `EMPTY` held stock and no longer does, kept rather
 * than deleted so a label that is scanned again resolves to its history instead
 * of to nothing.
 */
export const invHandlingUnitStatusEnum = pgEnum("inv_handling_unit_status", [
  "OPEN",
  "CLOSED",
  "SHIPPED",
  "EMPTY",
]);

/**
 * NEO-6 - how fast a SKU moves, as three buckets.
 *
 * ABC is the warehouse's own vocabulary and predates every WMS: A is the small
 * fraction of SKUs that account for most of the picks, C is the long tail. It is
 * derived from the ledger on a window, never entered by hand, because a class
 * somebody typed in last March is a class that is now wrong.
 */
export const invVelocityClassEnum = pgEnum("inv_velocity_class", ["A", "B", "C"]);

/** NEO-6. What a slotting rule matches on. */
export const invSlottingMatchEnum = pgEnum("inv_slotting_match", [
  "VELOCITY_CLASS",
  "CATEGORY",
  "PRODUCT_VARIANT",
]);

/**
 * NEO-6. A re-slot recommendation's life.
 *
 * `PENDING` until a person looks at it. Approving creates the work; nothing here
 * ever moves stock on its own, which is the difference between a slotting
 * *recommendation* and a warehouse that rearranges itself overnight.
 */
export const invSlottingRecommendationStatusEnum = pgEnum("inv_slotting_recommendation_status", [
  "PENDING",
  "APPROVED",
  "DISMISSED",
  "SUPERSEDED",
]);

/**
 * NEO-7 - which kind of work a labour record is about.
 *
 * Deliberately the four the floor actually walks. A record with no task behind it
 * is a timesheet, and timesheets are another module's problem.
 */
export const invLaborTaskKindEnum = pgEnum("inv_labor_task_kind", [
  "PICK",
  "PUTAWAY",
  "COUNT",
  "RECEIVE",
]);

/**
 * NEO-12 - a dock appointment's life.
 *
 * `BOOKED` is a slot somebody holds. `ARRIVED` is a vehicle at the door.
 * `COMPLETED` is unloaded or loaded. `NO_SHOW` is kept rather than deleted,
 * because a carrier that misses three slots is a fact worth being able to see.
 */
export const invDockAppointmentStatusEnum = pgEnum("inv_dock_appointment_status", [
  "BOOKED",
  "ARRIVED",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
]);

/** NEO-12. Which way goods move through a door. */
export const invDockDirectionEnum = pgEnum("inv_dock_direction", ["INBOUND", "OUTBOUND"]);
