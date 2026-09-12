import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

/**
 * B4/B5 — the picking surfaces.
 *
 * Two read paths here hand timestamps over as STRINGS rather than `Date`s, and
 * that is a property of how they are queried rather than of the columns: the
 * wave queue, the exception queue and `getWave`'s lines all go through
 * `db.execute` with hand-written SQL and are stringified by their mappers,
 * while `getWave`'s header is a drizzle row and is therefore a `Date`. The two
 * conventions sit inside one response and must not be declared alike.
 */

/** `WaveSummary` (`pick-wave-queue.ts`) — mapped, so its timestamps are strings. */
const waveSummarySchema = z.object({
  id: z.number().int(),
  pickNumber: z.string(),
  status: z.string(),
  warehouseId: z.number().int().nullable(),
  warehouseName: z.string().nullable(),
  assignedTo: z.string().nullable(),
  assignedToName: z.string().nullable(),
  claimedAt: z.string().nullable(),
  createdAt: z.string(),
  orderCount: z.number().int(),
  lineCount: z.number().int(),
  linesClosed: z.number().int(),
  /** B5. How many of this wave's lines are waiting on a reviewer. */
  openExceptions: z.number().int(),
});

export const listWavesResponseSchema = itemsPagedSchema(waveSummarySchema);

/**
 * One wave's lines, in the order a picker should walk them.
 *
 * Raw `db.execute` rows, so the keys are the SQL's own snake_case and nothing
 * here is camel-cased on the way out. `line_closed` and `needs_decision` are
 * derived server-side on purpose — a client copy of either rule would be a
 * fourth place for it to drift.
 */
const waveLineSchema = z.object({
  id: z.number().int(),
  so_line_id: z.number().int().nullable(),
  so_number: z.string().nullable(),
  product_variant_id: z.number().int(),
  sku: z.string(),
  variant_name: z.string(),
  location_id: z.number().int().nullable(),
  location_code: z.string().nullable(),
  lot_id: z.number().int().nullable(),
  lot_number: z.string().nullable(),
  serial_id: z.number().int().nullable(),
  serial_number: z.string().nullable(),
  quantity_to_pick: z.string(),
  quantity_picked: z.string(),
  exception_reason: z.string().nullable(),
  exception_notes: z.string().nullable(),
  exception_status: z.string().nullable(),
  exception_resolution: z.string().nullable(),
  exception_owner_id: z.string().nullable(),
  exception_owner_name: z.string().nullable(),
  exception_location_code: z.string().nullable(),
  substitute_variant_id: z.number().int().nullable(),
  substitute_sku: z.string().nullable(),
  substitute_quantity: z.string().nullable(),
  line_closed: z.boolean(),
  needs_decision: z.boolean(),
});

/** The whole `inv_pick_lists` row, plus its lines. */
export const getWaveResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  pickNumber: z.string(),
  soId: z.number().int().nullable(),
  warehouseId: z.number().int().nullable(),
  status: z.string(),
  createdBy: z.string(),
  assignedTo: z.string().nullable(),
  claimedAt: nullableWireDate(),
  createdByMembershipId: z.number().int().nullable(),
  cancelledAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  lines: z.array(waveLineSchema),
});

/**
 * `linesNeedingDecision` carries the ids rather than only the count: a client
 * needs to put those lines in front of somebody, and the count is derived from
 * them.
 */
export const createWaveResponseSchema = z.object({
  pickListId: z.number().int(),
  pickNumber: z.string(),
  orderCount: z.number().int(),
  lineCount: z.number().int(),
  unallocatedLines: z.number().int(),
  linesNeedingDecision: z.array(z.number().int()),
});

export const joinWaveResponseSchema = z.object({
  pickListId: z.number().int(),
  pickNumber: z.string(),
  joined: z.literal(true),
  addedOrderCount: z.number().int(),
  addedLineCount: z.number().int(),
  lineCount: z.number().int(),
  unallocatedLines: z.number().int(),
  linesNeedingDecision: z.array(z.number().int()),
});

/**
 * NEO-14 — `JoinDecision` (`waveless.ts`). A question, not a command: `reason`
 * is non-null exactly when the answer is no, and it is what the caller renders.
 */
export const proposeWaveJoinResponseSchema = z.object({
  join: z.boolean(),
  waveId: z.number().int().nullable(),
  reason: z.string().nullable(),
});

/**
 * `claimed` is false when the caller already held this wave: retrying a claim
 * is what a flaky warehouse network produces, and it is not a failure.
 */
export const claimWaveResponseSchema = z.object({
  pickListId: z.number().int(),
  assignedTo: z.string(),
  claimed: z.boolean(),
});

/** Abandoning gives up the walk, never the goods already in the tote. */
export const abandonWaveResponseSchema = z.object({
  pickListId: z.number().int(),
  assignedTo: z.null(),
  released: z.boolean(),
});

export const reassignWaveResponseSchema = z.object({
  pickListId: z.number().int(),
  assignedTo: z.string(),
});

/**
 * `reviveConfirm` (`pick-line.ts`). `pickedAtLocationId` is nullable only for a
 * replay of a response stored before a bin was required — a fresh confirm that
 * cannot resolve one is refused.
 */
export const confirmPickResponseSchema = z.object({
  pickLineId: z.number().int(),
  quantityPicked: z.string(),
  pickedAtLocationId: z.number().int().nullable(),
  waveComplete: z.boolean(),
  pickedBy: z.string(),
});

/** `PickExceptionResult` — the same shape for a fresh report and for a replay. */
export const reportPickExceptionResponseSchema = z.object({
  pickLineId: z.number().int(),
  reason: z.string(),
  status: z.enum(["OPEN", "RESOLVED"]),
  ownerUserId: z.string().nullable(),
  substituteVariantId: z.number().int().nullable(),
  substituteQuantity: z.string().nullable(),
  quantityPicked: z.string(),
  waveComplete: z.boolean(),
  reportedBy: z.string(),
});

/** `PickExceptionSummary` (`pick-exception-queue.ts`) — mapped, so strings. */
const pickExceptionSummarySchema = z.object({
  pickLineId: z.number().int(),
  pickListId: z.number().int(),
  pickNumber: z.string(),
  soNumber: z.string().nullable(),
  soLineId: z.number().int().nullable(),
  reason: z.string(),
  status: z.string(),
  resolution: z.string().nullable(),
  notes: z.string().nullable(),
  resolutionNotes: z.string().nullable(),
  ownerUserId: z.string().nullable(),
  ownerName: z.string().nullable(),
  reportedBy: z.string().nullable(),
  reportedByName: z.string().nullable(),
  reportedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  sku: z.string(),
  variantName: z.string(),
  substituteSku: z.string().nullable(),
  substituteQuantity: z.string().nullable(),
  quantityToPick: z.string(),
  quantityPicked: z.string(),
  locationCode: z.string().nullable(),
  foundLocationCode: z.string().nullable(),
  warehouseId: z.number().int().nullable(),
  warehouseName: z.string().nullable(),
  blocksWave: z.boolean(),
});

/**
 * `openCount` deliberately ignores the caller's status filter: a supervisor who
 * has filtered down to RESOLVED still needs to see that eleven are waiting.
 */
export const listPickExceptionsResponseSchema = itemsPagedSchema(
  pickExceptionSummarySchema,
).extend({
  openCount: z.number().int(),
});

export const assignPickExceptionResponseSchema = z.object({
  pickLineId: z.number().int(),
  ownerUserId: z.string(),
});

/** The wave still closes on a rejection — see the service's own note. */
export const resolvePickExceptionResponseSchema = z.object({
  pickLineId: z.number().int(),
  status: z.literal("RESOLVED"),
  resolution: z.string(),
  resolvedBy: z.string(),
  waveComplete: z.boolean(),
});
