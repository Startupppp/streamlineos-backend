import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

export const CONTACT_ROLE_DEFAULTS = [
  "decision_maker",
  "influencer",
  "champion",
  "blocker",
  "economic_buyer",
  "user",
] as const;

export const contactRoleCreateSchema = z.object({
  entityType: z.enum(["deal", "company"]),
  entityId: z.number().int().positive(),
  roleKey: z.string().min(1).max(100),
  isPrimary: z.boolean().default(false),
}).strict();

export const contactRoleListSchema = z.object({
  entityType: z.enum(["deal", "company"]).optional(),
  entityId: z.number().int().positive().optional(),
}).strict();

export const mergeContactsSchema = z.object({
  primaryId: z.number().int().positive(),
  duplicateId: z.number().int().positive(),
}).strict().refine((v) => v.primaryId !== v.duplicateId, {
  message: "primaryId and duplicateId must differ",
});

export const duplicatesQuerySchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
}).strict();

export type ContactRoleCreateInput = z.infer<typeof contactRoleCreateSchema>;
export type ContactRoleListInput = z.infer<typeof contactRoleListSchema>;
export type MergeContactsInput = z.infer<typeof mergeContactsSchema>;
export type DuplicatesQueryInput = z.infer<typeof duplicatesQuerySchema>;
