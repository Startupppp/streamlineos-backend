import { z } from "zod";
import { nullableWireDate, wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

/**
 * B3 — what the putaway workbench puts on the wire.
 *
 * Two grains with different casing, deliberately not reconciled here. The task
 * header comes back through drizzle's query builder, so it is camelCase with
 * real `Date` objects; the line rows come back from `db.execute` on hand-written
 * SQL, so they keep the column names and the `::text` casts the projection asked
 * for. Renaming either to match the other would be a wire change dressed up as a
 * schema, so the contract describes what each side actually sends.
 */
const putawayTaskSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  taskNumber: z.string(),
  warehouseId: z.number().int(),
  grnId: z.number().int().nullable(),
  fromLocationId: z.number().int(),
  status: z.string(),
  assignedTo: z.string().nullable(),
  claimedAt: nullableWireDate(),
  completedAt: nullableWireDate(),
  cancelledAt: nullableWireDate(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `PutawaySuggestion` — a bin the operator could walk this grain to. */
const putawaySuggestionSchema = z.object({
  locationId: z.number().int(),
  code: z.string(),
  name: z.string(),
  /** Null where the bin records no capacity, which means unlimited. */
  capacity: z.string().nullable(),
  onHand: z.string(),
  remaining: z.string().nullable(),
  holdsVariant: z.boolean(),
  fits: z.boolean(),
});

export const createPutawayTaskResponseSchema = z.object({
  taskId: z.number().int(),
  taskNumber: z.string(),
  lineCount: z.number().int(),
  quarantineLineCount: z.number().int(),
});

/**
 * The queue. `claimedAt`/`createdAt` are strings and not `wireDate()`: the mapper
 * puts each through `String(...)` on the way out, so what leaves is whatever
 * `Date.prototype.toString` produced, never an ISO timestamp.
 */
export const listPutawayTasksResponseSchema = itemsPagedSchema(
  z.object({
    id: z.number().int(),
    taskNumber: z.string(),
    status: z.string(),
    warehouseId: z.number().int(),
    warehouseName: z.string().nullable(),
    grnId: z.number().int().nullable(),
    grnNumber: z.string().nullable(),
    fromLocationId: z.number().int(),
    fromLocationCode: z.string().nullable(),
    assignedTo: z.string().nullable(),
    assignedToName: z.string().nullable(),
    claimedAt: z.string().nullable(),
    createdAt: z.string(),
    lineCount: z.number().int(),
    linesClosed: z.number().int(),
    quarantineLineCount: z.number().int(),
  }),
);

export const getPutawayTaskResponseSchema = z.object({
  task: putawayTaskSchema,
  lines: z.array(
    z.object({
      id: z.number().int(),
      product_variant_id: z.number().int(),
      sku: z.string(),
      variant_name: z.string(),
      lot_id: z.number().int().nullable(),
      lot_number: z.string().nullable(),
      serial_id: z.number().int().nullable(),
      serial_number: z.string().nullable(),
      quantity: z.string(),
      quantity_moved: z.string(),
      disposition: z.string(),
      to_location_id: z.number().int().nullable(),
      to_location_code: z.string().nullable(),
      /** `quantity − quantity_moved`, exact — never a float. */
      remaining: z.string(),
      suggestions: z.array(putawaySuggestionSchema),
    }),
  ),
});

/**
 * `claimed` is false when the caller already held the task: a retry over a flaky
 * warehouse network is not a failure, so it reports the standing claim rather
 * than conflicting.
 */
export const claimPutawayTaskResponseSchema = z.object({
  taskId: z.number().int(),
  assignedTo: z.string(),
  claimed: z.boolean(),
});

export const abandonPutawayTaskResponseSchema = z.object({
  taskId: z.number().int(),
  assignedTo: z.null(),
  released: z.boolean(),
});

export const cancelPutawayTaskResponseSchema = z.object({
  taskId: z.number().int(),
  status: z.literal("CANCELLED"),
});

/** `PutawayCompletionResult`, and the shape `revivePutawayCompletion` rebuilds. */
export const completePutawayResponseSchema = z.object({
  taskId: z.number().int(),
  status: z.enum(["IN_PROGRESS", "COMPLETED"]),
  lines: z.array(
    z.object({
      taskLineId: z.number().int(),
      quantityMoved: z.string(),
      toLocationId: z.number().int(),
    }),
  ),
  transactionIds: z.array(z.number().int()),
});
