import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

const cursorPagination = z.object({
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const hrFormRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  audience: z.string(),
  workflowObjectType: z.string().nullable(),
  schema: z.array(z.unknown()),
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
  schema: z.array(z.unknown()),
});
