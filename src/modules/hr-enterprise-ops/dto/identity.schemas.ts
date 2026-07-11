import { z } from "zod";

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const createProvisioningSchema = z.object({
  userId: z.string().uuid(),
  systemName: z.string().min(1).max(200),
  action: z.enum(["grant", "revoke", "review"]),
  triggeredBy: z.enum(["joiner", "mover", "leaver", "manual"]),
});

export const updateProvisioningSchema = z.object({
  systemName: z.string().min(1).max(200).optional(),
  action: z.enum(["grant", "revoke", "review"]).optional(),
  status: z.enum(["pending", "completed", "verified", "failed"]).optional(),
  completedAt: z.string().optional(),
  verifiedBy: z.string().uuid().nullable().optional(),
});

export const listProvisioningSchema = paginationSchema.extend({
  userId: z.string().uuid().optional(),
  triggeredBy: z.enum(["joiner", "mover", "leaver", "manual"]).optional(),
  status: z.enum(["pending", "completed", "verified", "failed"]).optional(),
});

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  triggeredBy: z.enum(["joiner", "mover", "leaver"]),
  systemsConfig: z.array(z.object({
    systemName: z.string().min(1).max(200),
    action: z.enum(["grant", "revoke", "review"]),
  })),
});

export const updateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  triggeredBy: z.enum(["joiner", "mover", "leaver"]).optional(),
  systemsConfig: z.array(z.object({
    systemName: z.string().min(1).max(200),
    action: z.enum(["grant", "revoke", "review"]),
  })).optional(),
});

export const generateProvisioningSchema = z.object({
  userId: z.string().uuid(),
  triggeredBy: z.enum(["joiner", "mover", "leaver"]),
});

export const exitVerificationSchema = z.object({
  userId: z.string().uuid(),
});

export type CreateProvisioningInput = z.infer<typeof createProvisioningSchema>;
export type UpdateProvisioningInput = z.infer<typeof updateProvisioningSchema>;
export type ListProvisioningInput = z.infer<typeof listProvisioningSchema>;
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export type GenerateProvisioningInput = z.infer<typeof generateProvisioningSchema>;
