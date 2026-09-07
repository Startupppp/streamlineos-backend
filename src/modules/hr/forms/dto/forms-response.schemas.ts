import { z } from "zod";
import { hrFormStatusEnum, hrFormAudienceEnum } from "../../../../db/schema/hr/forms";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

const cursorPagination = z.object({
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

const hrFormFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum([
    "text", "long_text", "number", "date", "select", "multi_select",
    "boolean", "file", "employee_ref", "department_ref", "currency",
  ]),
  required: z.boolean(),
  sensitive: z.boolean(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  conditional: z.object({
    fieldKey: z.string(),
    operator: z.enum(["eq", "neq", "contains", "notEmpty"]),
    value: z.unknown().optional(),
  }).nullable().optional(),
  validation: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional(),
  }).nullable().optional(),
});

export const hrFormRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  status: z.enum(hrFormStatusEnum.enumValues),
  audience: z.enum(hrFormAudienceEnum.enumValues),
  workflowObjectType: z.string().nullable(),
  schema: z.array(hrFormFieldSchema),
  createdBy: z.string().nullable(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const hrFormListSchema = z.object({
  data: z.array(hrFormRowSchema),
  total: z.number().int(),
  pagination: cursorPagination,
});

export const hrFormSubmissionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  formId: z.number().int(),
  formSchemaSnapshot: z.array(z.unknown()),
  submittedBy: z.string().nullable(),
  submittedByName: z.string().nullable(),
  subjectEmployeeId: z.number().int().nullable(),
  data: z.record(z.string(), z.unknown()),
  status: z.string(),
  workflowInstanceId: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const hrFormSubmissionListSchema = z.object({
  data: z.array(hrFormSubmissionRowSchema),
  total: z.number().int(),
  pagination: cursorPagination,
});

export const hrPublicFormSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  schema: z.array(hrFormFieldSchema),
});
