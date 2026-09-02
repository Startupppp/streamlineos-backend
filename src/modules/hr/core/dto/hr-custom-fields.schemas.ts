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

export const hrCustomFieldEntityTypeSchema = z.enum([
  "employee",
  "department",
  "job_role",
]);

const RESERVED_KEYS = new Set([
  "id",
  "email",
  "salary",
  "role",
  "status",
  "created_at",
  "updated_at",
  "deleted_at",
  "org_id",
  "user_id",
  "employee_id",
]);

const nameSchema = z
  .string()
  .min(3, "Name must be at least 3 characters")
  .max(100, "Name must be at most 100 characters")
  .refine((v) => v.trim().length >= 3, "Name must not be whitespace-only")
  .refine((v) => !/^[\s]*$/.test(v), "Name cannot be whitespace only")
  .refine((v) => !/^[^a-zA-ZÀ-ɏ]+$/.test(v.trim()), "Name must contain at least one letter")
  .refine((v) => !/^\p{Emoji}+$/u.test(v.trim()), "Name cannot be emoji-only");

const keySchema = z
  .string()
  .min(1, "Key is required")
  .max(64, "Key must be at most 64 characters")
  .regex(/^[a-z][a-z0-9_]*$/, "Key must start with a letter and contain only lowercase letters, numbers, and underscores")
  .refine((v) => !RESERVED_KEYS.has(v), "This key is reserved and cannot be used");

const validationRulesSchema = z.object({
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).optional(),
  minValue: z.number().optional(),
  maxValue: z.number().optional(),
  allowedOptions: z.array(z.string().min(1)).optional(),
  dateMin: z.string().optional(),
  dateMax: z.string().optional(),
}).optional();

const visibilitySchema = z.object({
  hrOnly: z.boolean().optional(),
  managerVisible: z.boolean().optional(),
  selfServiceVisible: z.boolean().optional(),
  hiddenFromExports: z.boolean().optional(),
}).optional();

const settingsSchema = z.object({
  helpText: z.string().max(500).optional(),
  placeholder: z.string().max(200).optional(),
  defaultValue: z.unknown().optional(),
  validationRules: validationRulesSchema,
  visibility: visibilitySchema,
  searchable: z.boolean().optional(),
  reportable: z.boolean().optional(),
}).optional();

export const createCustomFieldSchema = z.object({
  entityType: hrCustomFieldEntityTypeSchema,
  name: nameSchema,
  key: keySchema,
  fieldType: fieldTypeEnum,
  options: z
    .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
    .optional(),
  settings: settingsSchema,
  isSensitive: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  displayOrder: z.number().int().min(0).optional(),
}).strict();

export const updateCustomFieldSchema = z.object({
  name: nameSchema.optional(),
  options: z
    .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
    .optional(),
  settings: settingsSchema,
  isSensitive: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  isActive: z.boolean().optional(),
  displayOrder: z.number().int().min(0).optional(),
}).strict();

export const upsertCustomFieldValuesSchema = z.object({
  values: z
    .array(
      z.object({
        fieldDefinitionId: z.number().int().positive(),
        value: z.unknown(),
      }),
    )
    .min(1)
    .max(100),
}).strict().superRefine((input, context) => {
  const seen = new Set<number>();
  input.values.forEach((item, index) => {
    if (seen.has(item.fieldDefinitionId)) {
      context.addIssue({
        code: "custom",
        path: ["values", index, "fieldDefinitionId"],
        message: "Each custom field may be submitted only once.",
      });
    }
    seen.add(item.fieldDefinitionId);
  });
});

export const filterByCustomFieldQuerySchema = z.object({
  fieldKey: z
    .string()
    .min(1, "fieldKey is required")
    .max(64, "fieldKey must be at most 64 characters")
    .regex(/^[a-z][a-z0-9_]*$/, "fieldKey must be a valid field key"),
  value: z.string().optional(),
}).strict();

export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;
export type UpsertCustomFieldValuesInput = z.infer<typeof upsertCustomFieldValuesSchema>;
export type FilterByCustomFieldQuery = z.infer<typeof filterByCustomFieldQuerySchema>;
