import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const crmSequenceSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  entityType: z.string(),
  isActive: z.boolean(),
  stopOn: z.unknown().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const crmSequenceStepSchema = z.object({
  id: z.string(),
  sequenceId: z.string(),
  sortOrder: z.number().int(),
  stepType: z.string(),
  config: z.unknown().nullable(),
  waitHours: z.number().int().nullable(),
});

export const crmSequenceEnrollmentSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  sequenceId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  status: z.string(),
  currentStep: z.number().int(),
  nextRunAt: nullableWireDate(),
  stopReason: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const sequencesListSchema = z.object({
  sequences: z.array(crmSequenceSchema),
});

export const sequenceSingleSchema = z.object({
  sequence: crmSequenceSchema,
});

export const stepsListSchema = z.object({
  steps: z.array(crmSequenceStepSchema),
});

export const stepSingleSchema = z.object({
  step: crmSequenceStepSchema,
});

export const enrollmentsListSchema = z.object({
  enrollments: z.array(crmSequenceEnrollmentSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const enrollmentSingleSchema = z.object({
  enrollment: crmSequenceEnrollmentSchema,
});

export { successSchema };
