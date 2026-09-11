import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

/**
 * The entity types this route owns, and the whole of them.
 *
 * `custom_field_definitions` is shared: Support writes `ticket` rows, HR writes
 * `employee` rows, Build writes its own. Every other module constrains its reads
 * AND its writes to its own constant; this route constrained neither, so a
 * holder of the old global settings key could edit or delete another module's
 * definition by id through a global path. The constant is exported so the
 * service predicates and the request schemas cannot drift apart.
 */
export const CRM_CUSTOM_FIELD_ENTITY_TYPES = ["lead", "deal", "contact"] as const;

/**
 * The filter is the same enum the create payload accepts. It was `z.string()`,
 * which let any value through to an equality predicate and hid the fact that
 * this surface is CRM-only — the enum is the evidence.
 */
export const customFieldsListSchema = z.object({
  entityType: z.enum(CRM_CUSTOM_FIELD_ENTITY_TYPES).optional(),
  limit: pageSizeField(50),
  cursor: z.string().optional(),
}).strict();

export const createCustomFieldSchema = z.object({
  entityType: z.enum(CRM_CUSTOM_FIELD_ENTITY_TYPES),
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/, {
      message:
        "Name must be snake_case (lowercase letters, digits, underscores only, starting with a letter)",
    }),
  label: z.string().min(1),
  fieldType: z
    .enum(["text", "number", "date", "boolean", "select"])
    .default("text"),
  options: z
    .array(z.object({ value: z.string().min(1), label: z.string().min(1) }).strict())
    .optional(),
  isRequired: z.boolean().optional().default(false),
  sortOrder: z.number().int().optional().default(0),
}).strict();

export const updateCustomFieldSchema = z.object({
  label: z.string().min(1).optional(),
  options: z
    .array(z.object({ value: z.string().min(1), label: z.string().min(1) }).strict())
    .optional()
    .nullable(),
  isRequired: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
}).strict();

export type CustomFieldsListInput = z.infer<typeof customFieldsListSchema>;
export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;
