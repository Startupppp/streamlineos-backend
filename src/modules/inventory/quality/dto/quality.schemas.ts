import { z } from "zod";
import { recallSelectionSchema } from "./recall-simulation.schemas";

export const listInspectionsQuerySchema = z.object({
  status: z.enum(["PENDING", "IN_PROGRESS", "PASSED", "FAILED", "DISPOSITION_REQUIRED", "COMPLETED", "CANCELLED"]).optional(),
  sourceType: z.string().optional(),
  productVariantId: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type ListInspectionsQueryInput = z.infer<typeof listInspectionsQuerySchema>;

export const createInspectionSchema = z.object({
  sourceType: z.string().optional(),
  sourceId: z.string().optional(),
  inspectorUserId: z.string().optional(),
  notes: z.string().optional(),
  lines: z.array(z.object({
    productVariantId: z.number().int(),
    /**
     * Where the units stand. Optional because a manual inspection may be raised
     * before anybody has looked; a line without one falls back to a lookup at
     * disposition time, which cannot tell two bins of one SKU apart.
     */
    locationId: z.number().int().positive().optional(),
    lotId: z.number().int().optional(),
    serialId: z.number().int().optional(),
    quantity: z.string().regex(/^\d+(\.\d+)?$/),
    notes: z.string().optional(),
  }).strict()).min(1),
}).strict();
export type CreateInspectionInput = z.infer<typeof createInspectionSchema>;

const disposeLineSchema = z.object({
  lineId: z.number().int(),
  disposition: z.enum(["RELEASE_TO_AVAILABLE", "QUARANTINE", "RETURN_TO_VENDOR", "SCRAP"]),
  vendorId: z.number().int().optional(),
  locationId: z.number().int().optional(),
}).strict();

export const disposeInspectionSchema = z.object({
  lines: z.array(disposeLineSchema).min(1),
}).strict().refine(d => d.lines.every(l => l.disposition !== "RETURN_TO_VENDOR" || l.vendorId != null), {
  message: "vendorId required for RETURN_TO_VENDOR disposition",
  path: ["lines"],
});
export type DisposeInspectionInput = z.infer<typeof disposeInspectionSchema>;

export const failInspectionSchema = z.object({
  lines: z.array(z.object({
    lineId: z.number().int(),
    disposition: z.enum(["RELEASE_TO_AVAILABLE", "QUARANTINE", "RETURN_TO_VENDOR", "SCRAP"]),
    notes: z.string().optional(),
  }).strict()).min(1),
}).strict();
export type FailInspectionInput = z.infer<typeof failInspectionSchema>;

export const listHoldsQuerySchema = z.object({
  status: z.enum(["ACTIVE", "RELEASED"]).optional(),
  productVariantId: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type ListHoldsQueryInput = z.infer<typeof listHoldsQuerySchema>;

export const createHoldSchema = z.object({
  productVariantId: z.number().int(),
  locationId: z.number().int(),
  lotId: z.number().int().optional(),
  serialId: z.number().int().optional(),
  quantity: z.string().regex(/^\d+(\.\d+)?$/),
  reason: z.string().min(1),
}).strict();
export type CreateHoldInput = z.infer<typeof createHoldSchema>;

export const listRecallsQuerySchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "CLOSED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type ListRecallsQueryInput = z.infer<typeof listRecallsQuerySchema>;

/**
 * D4. Executing a recall.
 *
 * Two ways in, and they are not equivalent. `lines` is the explicit form — the
 * caller already knows exactly which lots and serials, and takes
 * responsibility for that list. `selection` is the simulated form: the caller
 * states the *question* ("this vendor's March deliveries"), and must present
 * the `evidenceVersion` a simulate returned for that same question. The server
 * re-runs the simulation and refuses if the picture has moved, so a recall is
 * never executed against numbers an operator read ten minutes ago.
 *
 * `evidenceVersion` is required with `selection` rather than optional: a
 * selection-shaped recall that skips the simulate is exactly the unexamined
 * blast radius this unit exists to prevent.
 */
export const createRecallSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  lines: z.array(z.object({
    productVariantId: z.number().int().optional(),
    lotId: z.number().int().optional(),
    serialId: z.number().int().optional(),
  }).strict()).min(1).optional(),
  selection: recallSelectionSchema.optional(),
  evidenceVersion: z.string().min(1).max(128).optional(),
}).strict()
  .refine((b) => (b.lines === undefined) !== (b.selection === undefined), {
    message: "Provide exactly one of lines or selection",
    path: ["selection"],
  })
  .refine((b) => b.selection === undefined || b.evidenceVersion !== undefined, {
    message: "evidenceVersion is required when a recall is raised from a selection — simulate first",
    path: ["evidenceVersion"],
  })
  .refine((b) => b.selection !== undefined || b.evidenceVersion === undefined, {
    message: "evidenceVersion only applies to a selection-based recall",
    path: ["evidenceVersion"],
  });
export type CreateRecallInput = z.infer<typeof createRecallSchema>;

export const updateRecallSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "CLOSED"]).optional(),
  notes: z.string().optional(),
}).strict();
export type UpdateRecallInput = z.infer<typeof updateRecallSchema>;
