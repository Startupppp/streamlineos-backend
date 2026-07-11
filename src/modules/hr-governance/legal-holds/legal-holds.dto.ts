import { z } from "zod";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const createLegalHoldSchema = z.object({
  subjectUserId: z.string().min(1),
  reason: z.string().min(5).max(2000),
  restrictedExport: z.boolean().optional(),
});

export const updateLegalHoldSchema = z.object({
  reason: z.string().min(5).max(2000).optional(),
  restrictedExport: z.boolean().optional(),
});

export const listLegalHoldsSchema = paginationSchema.extend({
  status: z.enum(["active", "released"]).optional(),
  subjectUserId: z.string().optional(),
});

export const attachHoldItemSchema = z.object({
  itemType: z.enum(["employee_profile", "document", "case_evidence"]),
  itemRef: z.string().min(1).max(500),
  locked: z.boolean().optional(),
});

export type CreateLegalHoldInput = z.infer<typeof createLegalHoldSchema>;
export type UpdateLegalHoldInput = z.infer<typeof updateLegalHoldSchema>;
export type ListLegalHoldsInput = z.infer<typeof listLegalHoldsSchema>;
export type AttachHoldItemInput = z.infer<typeof attachHoldItemSchema>;
