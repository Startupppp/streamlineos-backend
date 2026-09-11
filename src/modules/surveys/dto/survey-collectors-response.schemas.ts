import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

export const surveyCollectorRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  surveyId: z.number().int(),
  versionId: z.number().int().nullable(),
  collectorType: z.string(),
  name: z.string(),
  token: z.string(),
  status: z.enum(["active", "paused", "closed", "expired"]),
  source: z.string().nullable(),
  utm: z.record(z.string(), z.unknown()),
  settings: z.record(z.string(), z.unknown()),
  opens: z.number().int(),
  starts: z.number().int(),
  completions: z.number().int(),
  expiresAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const surveyCollectorListSchema = z.array(surveyCollectorRowSchema);
