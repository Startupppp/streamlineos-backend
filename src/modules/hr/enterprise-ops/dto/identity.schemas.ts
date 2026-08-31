import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

const paginationSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
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

const ALPHANUMERIC_RE = /[a-zA-Z0-9]/;

const templateNameSchema = z
  .string()
  .min(1, "Template name is required")
  .max(200, "Template name must be 200 characters or fewer")
  .refine((v) => v.trim().length > 0, { message: "Template name cannot be only whitespace" })
  .refine((v) => ALPHANUMERIC_RE.test(v), { message: "Template name must contain at least one letter or digit" })
  .transform((v) => v.trim());

const systemConfigItemSchema = z.object({
  systemName: z
    .string()
    .min(1, "System name is required")
    .max(200, "System name must be 200 characters or fewer")
    .transform((v) => v.trim()),
  action: z.enum(["grant", "revoke", "review"]),
});

export const createTemplateSchema = z.object({
  name: templateNameSchema,
  triggeredBy: z.enum(["joiner", "mover", "leaver"]),
  systemsConfig: z
    .array(systemConfigItemSchema)
    .min(1, "At least one system is required"),
});

export const updateTemplateSchema = z.object({
  name: templateNameSchema.optional(),
  triggeredBy: z.enum(["joiner", "mover", "leaver"]).optional(),
  systemsConfig: z
    .array(systemConfigItemSchema)
    .min(1, "At least one system is required")
    .optional(),
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
