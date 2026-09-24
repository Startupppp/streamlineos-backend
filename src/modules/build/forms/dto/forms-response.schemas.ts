import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { formSubmissionStatusEnum } from "../../../../db/schema";

export const formRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  formNumber: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  fields: z.unknown(),
  actions: z.unknown(),
  isActive: z.boolean(),
  isPublic: z.boolean(),
  publicToken: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const submissionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  formId: z.number().int(),
  projectId: z.number().int(),
  values: z.unknown(),
  status: z.enum(formSubmissionStatusEnum.enumValues),
  submittedByName: z.string().nullable(),
  submittedById: z.string().nullable(),
  convertedTicketId: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const submissionCreateResultSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  formId: z.number().int(),
  projectId: z.number().int(),
  values: z.unknown(),
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
  values: z.unknown(),
  createdAt: wireDate(),
  executedActionTypes: z.array(z.string()),
  skippedActionTypes: z.array(z.string()),
});
