import { z } from "zod";

export const mergeOrgsSchema = z.object({
  primaryId: z.number().int().positive(),
  duplicateId: z.number().int().positive(),
}).refine((v) => v.primaryId !== v.duplicateId, {
  message: "primaryId and duplicateId must differ",
});

export const orgDuplicatesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type MergeOrgsInput = z.infer<typeof mergeOrgsSchema>;
export type OrgDuplicatesQueryInput = z.infer<typeof orgDuplicatesQuerySchema>;
