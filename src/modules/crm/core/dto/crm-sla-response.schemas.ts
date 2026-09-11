import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const slaPolicySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  appliesTo: z.string(),
  priority: z.string(),
  firstResponseHours: z.number().int(),
  resolutionHours: z.number().int(),
  conditions: z.unknown(),
  targetMinutes: z.number().int().nullable(),
  businessHours: z.boolean(),
  appliesToText: z.string().nullable(),
  priorityText: z.string().nullable(),
  createdAt: wireDate(),
});

export const slaBreachedLeadSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string().nullable(),
  status: z.string(),
  priority: z.string(),
  slaDeadline: nullableWireDate(),
  createdAt: wireDate(),
});

export const slaBreachedListSchema = z.array(slaBreachedLeadSchema);

export const slaReportSchema = z.object({
  total: z.number().int(),
  compliant: z.number().int(),
  breached: z.number().int(),
  complianceRate: z.number().int(),
});
