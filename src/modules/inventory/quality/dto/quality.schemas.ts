import { z } from "zod";

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

export const createRecallSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  lines: z.array(z.object({
    productVariantId: z.number().int().optional(),
    lotId: z.number().int().optional(),
    serialId: z.number().int().optional(),
  }).strict()).min(1),
}).strict();
export type CreateRecallInput = z.infer<typeof createRecallSchema>;

export const updateRecallSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "CLOSED"]).optional(),
  notes: z.string().optional(),
}).strict();
export type UpdateRecallInput = z.infer<typeof updateRecallSchema>;
