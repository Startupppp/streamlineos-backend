import { z } from "zod";

export const CONTACT_ROLE_DEFAULTS = [
  "decision_maker",
  "influencer",
  "champion",
  "blocker",
  "economic_buyer",
  "user",
] as const;

export type ContactRoleKey = (typeof CONTACT_ROLE_DEFAULTS)[number];

export const contactRoleCreateSchema = z.object({
  entityType: z.enum(["deal", "company"]),
  entityId: z.number().int().positive(),
  roleKey: z.string().min(1).max(100),
  isPrimary: z.boolean().default(false),
});

export const contactRoleListSchema = z.object({
  entityType: z.enum(["deal", "company"]).optional(),
  entityId: z.number().int().positive().optional(),
});

export const mergeContactsSchema = z.object({
  primaryId: z.number().int().positive(),
  duplicateId: z.number().int().positive(),
}).refine((v) => v.primaryId !== v.duplicateId, {
  message: "primaryId and duplicateId must differ",
});

export const duplicatesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ContactRoleCreateInput = z.infer<typeof contactRoleCreateSchema>;
export type ContactRoleListInput = z.infer<typeof contactRoleListSchema>;
export type MergeContactsInput = z.infer<typeof mergeContactsSchema>;
export type DuplicatesQueryInput = z.infer<typeof duplicatesQuerySchema>;
