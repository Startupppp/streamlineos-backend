import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const entrySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userMembershipId: z.number().int().nullable(),
  ticketId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  date: z.string(),
  hours: z.string(),
  description: z.string().nullable(),
  isBillable: z.boolean(),
  billingType: z.string(),
  status: z.string(),
  submittedAt: nullableWireDate(),
  approvedBy: z.string().nullable(),
  approvedAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  lockedAt: nullableWireDate(),
  voidedAt: nullableWireDate(),
  invoicingStatus: z.string(),
  billRate: z.string().nullable(),
  currency: z.string().nullable(),
  rateSource: z.string().nullable(),
  source: z.string(),
  workLink: z.string().nullable(),
  timesheetPeriodId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  project: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  ticket: z.object({
    id: z.number().int(),
    title: z.string(),
    ticketNumber: z.number().int(),
    project: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  }).nullable(),
});

export const entriesListResponseSchema = z.object({
  data: z.array(entrySchema),
  pagination: z.object({ hasNextPage: z.boolean(), cursor: z.string().nullable() }).optional(),
});

export const attendanceDraftResponseSchema = z.object({
  enabled: z.boolean(),
  segmentsFound: z.number().int(),
  entriesCreated: z.number().int(),
  skippedExisting: z.number().int(),
  skippedEmpty: z.number().int(),
  periodIds: z.array(z.number().int()),
});
