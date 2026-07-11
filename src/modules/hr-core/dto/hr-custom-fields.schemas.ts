import { z } from "zod";

const fieldTypeEnum = z.enum([
  "text",
  "number",
  "date",
  "select",
  "multi_select",
  "boolean",
  "file",
  "employee_ref",
  "department_ref",
  "currency",
]);

export const createCustomFieldSchema = z.object({
  entityType: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  key: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_]*$/, "Key must be snake_case"),
  fieldType: fieldTypeEnum,
  options: z
    .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
    .optional(),
  isSensitive: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  displayOrder: z.number().int().min(0).optional(),
});

export const updateCustomFieldSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  options: z
    .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
    .optional(),
  isSensitive: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  isActive: z.boolean().optional(),
  displayOrder: z.number().int().min(0).optional(),
});

export const upsertCustomFieldValuesSchema = z.object({
  values: z.array(
    z.object({
      fieldDefinitionId: z.number().int().positive(),
      value: z.unknown(),
    }),
  ),
});

export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;
export type UpsertCustomFieldValuesInput = z.infer<typeof upsertCustomFieldValuesSchema>;
