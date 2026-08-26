import { z } from "zod";

/**
 * A field name as the layout description publishes it.
 *
 * Bounded because these are echoed back into a rendered page: an arrangement is
 * tenant-supplied data, and the renderer addresses fields by name.
 */
const fieldName = z.string().trim().min(1).max(64);

const groupSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    fields: z.array(fieldName).max(200),
  })
  .strict();

/**
 * What a tenant may send.
 *
 * `updatedAt` is deliberately absent: the server owns it, and accepting a
 * client's would let a stale tab present itself as the newer write.
 */
export const layoutAdjustmentInputSchema = z
  .object({
    order: z.array(fieldName).max(200).optional(),
    hidden: z.array(fieldName).max(200).optional(),
    groups: z.array(groupSchema).max(40).optional(),
  })
  .strict();

/**
 * The address of a record type: `party`, `subject:property`.
 *
 * Constrained rather than free text because it is a key, not a label, and an
 * unconstrained one becomes a way to write unbounded rows into a tenant's table.
 */
export const layoutKeyParamSchema = z
  .object({
    layoutKey: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9-]*(:[a-z0-9-]+)?$/, "a layout key, e.g. party or subject:property"),
  })
  .strict();

export type LayoutAdjustmentInput = z.infer<typeof layoutAdjustmentInputSchema>;
