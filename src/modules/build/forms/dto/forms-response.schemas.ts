import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { formSubmissionStatusEnum, formTypeEnum } from "../../../../db/schema";

const formFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["text", "long_text", "number", "date", "dropdown", "multiselect", "checkbox", "url", "user", "currency", "rating"]),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

const formActionSchema = z.object({
  type: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const formRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  formNumber: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.enum(formTypeEnum.enumValues),
  fields: z.array(formFieldSchema),
  actions: z.array(formActionSchema),
  isActive: z.boolean(),
  isPublic: z.boolean(),
  publicToken: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

const formPaginationSchema = z.object({
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const formPageSchema = z.object({
  data: z.array(formRowSchema),
  pagination: formPaginationSchema,
});

export const submissionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  formId: z.number().int(),
  projectId: z.number().int(),
  values: z.record(z.string(), z.unknown()),
  status: z.enum(formSubmissionStatusEnum.enumValues),
  submittedByName: z.string().nullable(),
  submittedById: z.string().nullable(),
  convertedTicketId: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const submissionPageSchema = z.object({
  data: z.array(submissionRowSchema),
  pagination: z.object({
    limit: z.number().int().positive(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const submissionCreateResultSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  formId: z.number().int(),
  projectId: z.number().int(),
  values: z.record(z.string(), z.unknown()),
  status: z.enum(formSubmissionStatusEnum.enumValues),
  submittedByName: z.string().nullable(),
  submittedById: z.string().nullable(),
  convertedTicketId: z.number().int().nullable(),
  createdAt: wireDate(),
  createdTicketIds: z.array(z.number().int()),
  executedActionTypes: z.array(z.string()),
  skippedActionTypes: z.array(z.string()),
});

export const publicSubmissionResultSchema = z.object({
  id: z.number().int(),
  status: z.enum(formSubmissionStatusEnum.enumValues),
  submittedByName: z.string().nullable(),
  values: z.record(z.string(), z.unknown()),
  createdAt: wireDate(),
  executedActionTypes: z.array(z.string()),
  skippedActionTypes: z.array(z.string()),
});
