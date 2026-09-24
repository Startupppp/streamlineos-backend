import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import {
  incidentFollowUpStatusSchema,
  incidentSeveritySchema,
  incidentStatusSchema,
} from "./incidents.schemas";

export const incidentRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  incidentNumber: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  severity: incidentSeveritySchema,
  status: incidentStatusSchema,
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
  releaseId: z.number().int().nullable(),
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
  newStatus: incidentStatusSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const incidentDecisionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  incidentId: z.number().int(),
  decision: z.string(),
  rationale: z.string().nullable(),
  decidedBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const incidentFollowUpActionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  incidentId: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  ownerId: z.string().nullable(),
  status: incidentFollowUpStatusSchema,
  dueAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const incidentDetailSchema = incidentRowSchema.extend({
  updates: z.array(incidentUpdateRowSchema.extend({
    createdByName: z.string().nullable(),
    createdByEmail: z.string().nullable(),
  })),
  decisions: z.array(incidentDecisionRowSchema),
  followUpActions: z.array(incidentFollowUpActionRowSchema),
  childrenPagination: z.object({
    updates: z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.number().int().nullable() }),
    decisions: z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.number().int().nullable() }),
    followUpActions: z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.number().int().nullable() }),
  }),
});
