import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const incidentRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  incidentNumber: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  severity: z.string(),
  status: z.string(),
  impact: z.string().nullable(),
  ownerId: z.string().nullable(),
  rootCause: z.string().nullable(),
  customerComms: z.string().nullable(),
  detectedAt: nullableWireDate(),
  respondedAt: nullableWireDate(),
  resolvedAt: nullableWireDate(),
  responseDueAt: nullableWireDate(),
  resolutionDueAt: nullableWireDate(),
  linkedTicketId: z.number().int().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const incidentUpdateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  incidentId: z.number().int(),
  message: z.string(),
  newStatus: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const incidentDetailSchema = incidentRowSchema.extend({
  updates: z.array(incidentUpdateRowSchema.extend({
    createdByName: z.string().nullable(),
    createdByEmail: z.string().nullable(),
  })),
});
