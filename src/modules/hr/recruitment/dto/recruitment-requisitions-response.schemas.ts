import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const requisitionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  department: z.string().nullable(),
  location: z.string().nullable(),
  headcount: z.number().int(),
  hiringManagerId: z.string().nullable(),
  hiringManagerMembershipId: z.number().int().nullable(),
  priority: z.string(),
  type: z.string(),
  status: z.string(),
  requestedBy: z.string(),
  requestedByMembershipId: z.number().int().nullable(),
  approverId: z.string().nullable(),
  approverMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  justification: z.string().nullable(),
  targetDate: z.string().nullable(),
  linkedJobId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const createJobFromRequisitionResponseSchema = z.object({
  jobId: z.number().int(),
  jobTitle: z.string(),
});
