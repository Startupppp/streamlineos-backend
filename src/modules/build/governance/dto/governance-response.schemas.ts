import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const riskRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  riskNumber: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  probability: z.string(),
  impact: z.string(),
  status: z.string(),
  ownerId: z.string().nullable(),
  mitigation: z.string().nullable(),
  linkedTicketId: z.number().int().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const decisionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  decisionNumber: z.number().int(),
  title: z.string(),
  context: z.string().nullable(),
  decision: z.string().nullable(),
  optionsConsidered: z.string().nullable(),
  status: z.string(),
  ownerId: z.string().nullable(),
  decidedAt: nullableWireDate(),
  revisitAt: nullableWireDate(),
  linkedTicketId: z.number().int().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const riskPageSchema = z.object({
  data: z.array(riskRowSchema),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nullable(),
});

export const decisionPageSchema = z.object({
  data: z.array(decisionRowSchema),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nullable(),
});
