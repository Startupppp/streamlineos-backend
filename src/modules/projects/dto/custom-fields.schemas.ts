import { z } from "zod";

const customFieldTypes = ["text", "number", "date", "user", "select", "multi_select", "checkbox", "url", "currency"] as const;

export const createCustomFieldSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(customFieldTypes).default("text"),
  options: z.array(z.string()).optional().nullable(),
  required: z.boolean().default(false),
  position: z.number().int().default(0),
});

export const updateCustomFieldSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.enum(customFieldTypes).optional(),
  options: z.array(z.string()).optional().nullable(),
  required: z.boolean().optional(),
  position: z.number().int().optional(),
});

export const upsertCustomFieldValueSchema = z.object({
  fieldId: z.number().int(),
  value: z.string().optional().nullable(),
});

export const upsertCustomFieldValuesSchema = z.object({
  values: z.array(upsertCustomFieldValueSchema),
});

export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;
export type UpsertCustomFieldValuesInput = z.infer<typeof upsertCustomFieldValuesSchema>;
