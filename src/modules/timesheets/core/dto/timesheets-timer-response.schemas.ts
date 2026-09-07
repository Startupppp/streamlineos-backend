import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const timerSchema = z.object({
  id: z.number().int(),
  userMembershipId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  ticketId: z.number().int().nullable(),
  description: z.string().nullable(),
  billable: z.boolean(),
  startedAt: wireDate(),
  lastResumedAt: nullableWireDate(),
  accumulatedSeconds: z.number().int(),
  status: z.string(),
  elapsedSeconds: z.number().int(),
  project: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  ticket: z.object({ id: z.number().int(), title: z.string() }).nullable(),
});

export const timerNullableResponseSchema = timerSchema.nullable();
