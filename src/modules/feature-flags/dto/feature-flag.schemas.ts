import { z } from "zod";

export const createFlagSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_]+$/, "Key must be lowercase alphanumeric with underscores"),
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  type: z.enum(["global", "percentage", "org", "user"]).default("global"),
  enabled: z.boolean().default(false),
  rolloutPercentage: z.number().int().min(0).max(100).default(0),
  expiresAt: z.coerce.date().optional(),
}).strict();

export const updateFlagSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  rolloutPercentage: z.number().int().min(0).max(100).optional(),
  expiresAt: z.coerce.date().nullable().optional(),
}).strict();

export const orgOverrideSchema = z.object({
  orgId: z.string().min(1),
  enabled: z.boolean(),
}).strict();

export type CreateFlagInput = z.infer<typeof createFlagSchema>;
export type UpdateFlagInput = z.infer<typeof updateFlagSchema>;
export type OrgOverrideInput = z.infer<typeof orgOverrideSchema>;
