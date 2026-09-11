import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { timesheetPeriodSchema } from "./timesheets-approvals-response.schemas";

export const periodsListResponseSchema = z.array(timesheetPeriodSchema);

export const periodDetailResponseSchema = z.object({
  period: timesheetPeriodSchema,
  entries: z.array(z.object({
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
    approvedAt: nullableWireDate(),
    approvedByMembershipId: z.number().int().nullable(),
    rejectionReason: z.string().nullable(),
    voidedAt: nullableWireDate(),
    invoicingStatus: z.string(),
    billRate: z.string().nullable(),
    currency: z.string().nullable(),
    timesheetPeriodId: z.number().int().nullable(),
    createdAt: wireDate(),
    updatedAt: wireDate(),
  })),
});
