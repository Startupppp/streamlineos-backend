import { z } from "zod";

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

export type ContactRoleCreateInput = z.infer<typeof contactRoleCreateSchema>;
export type ContactRoleListInput = z.infer<typeof contactRoleListSchema>;
