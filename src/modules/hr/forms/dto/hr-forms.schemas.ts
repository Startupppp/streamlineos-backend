import { z } from "zod";

export const hrFormFieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_]*$/, "Key must be snake_case"),
  label: z.string().min(1).max(200),
  type: z.enum([
    "text",
    "long_text",
    "number",
    "date",
    "select",
    "multi_select",
    "boolean",
    "file",
    "employee_ref",
    "department_ref",
    "currency",
  ]),
  required: z.boolean(),
  sensitive: z.boolean(),
  options: z
    .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
    .optional(),
  conditional: z
    .object({
      fieldKey: z.string().min(1),
      operator: z.enum(["eq", "neq", "contains", "notEmpty"]),
      value: z.unknown().optional(),
    })
    .nullable()
    .optional(),
  validation: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      pattern: z.string().optional(),
    })
    .nullable()
    .optional(),
});

const hrFormNameSchema = z
  .string()
  .min(1, "Name is required")
  .max(300, "Name must be at most 300 characters")
  .transform((v) => v.trim())
  .refine((v) => v.length >= 3, "Name must be at least 3 characters")
  .refine((v) => /[a-zA-Z]/.test(v), "Name must contain at least one letter");

export const createHrFormSchema = z.object({
  name: hrFormNameSchema,
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase-kebab"),
  description: z.string().max(1000).optional(),
  audience: z.enum(["internal", "public"]),
  workflowObjectType: z.string().max(100).nullable().optional(),
  schema: z.array(hrFormFieldSchema),
});

export const updateHrFormSchema = z.object({
  name: hrFormNameSchema.optional(),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().max(1000).nullable().optional(),
  audience: z.enum(["internal", "public"]).optional(),
  workflowObjectType: z.string().max(100).nullable().optional(),
  schema: z.array(hrFormFieldSchema).optional(),
});

export const listHrFormsQuerySchema = z.object({
  status: z.enum(["draft", "active", "archived"]).optional(),
  audience: z.enum(["internal", "public"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const submitHrFormSchema = z.object({
  data: z.record(z.string(), z.unknown()),
  submittedByName: z.string().max(200).optional(),
  subjectEmployeeId: z.number().int().positive().optional(),
});

export const updateSubmissionStatusSchema = z.object({
  status: z.enum(["submitted", "in_review", "approved", "rejected"]),
});

export const listSubmissionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(["submitted", "in_review", "approved", "rejected"]).optional(),
});

export type CreateHrFormInput = z.infer<typeof createHrFormSchema>;
export type UpdateHrFormInput = z.infer<typeof updateHrFormSchema>;
export type ListHrFormsQuery = z.infer<typeof listHrFormsQuerySchema>;
export type SubmitHrFormInput = z.infer<typeof submitHrFormSchema>;
export type UpdateSubmissionStatusInput = z.infer<typeof updateSubmissionStatusSchema>;
export type ListSubmissionsQuery = z.infer<typeof listSubmissionsQuerySchema>;
