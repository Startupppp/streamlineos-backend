import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const payrollJobRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  entityId: z.number().int().nullable(),
  jobType: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  status: z.string(),
  progress: z.number().int(),
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  correlationId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  errorMessage: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  startedAt: nullableWireDate(),
  finishedAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const payrollJobListSchema = cursorPageSchema(payrollJobRowSchema);

export const enqueueJobResponseSchema = z.object({
  jobId: z.number().int(),
  status: z.string(),
  correlationId: z.string().nullable(),
  progress: z.number().int(),
});
