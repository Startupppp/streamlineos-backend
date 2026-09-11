import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

export const travelRequestSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  purpose: z.string(),
  destination: z.string(),
  departureDate: z.string(),
  returnDate: z.string(),
  flightRequired: z.boolean(),
  hotelRequired: z.boolean(),
  advanceRequired: z.boolean(),
  advanceAmount: z.string().nullable(),
  estimatedCost: z.string().nullable(),
  perDiem: z.string().nullable(),
  itinerary: z.array(
    z.object({ date: z.string(), activity: z.string(), location: z.string() }),
  ),
  status: z.string(),
  managerApproverId: z.string().nullable(),
  managerApproverMembershipId: z.number().int().nullable(),
  managerApprovedAt: nullableWireDate(),
  financeApproverId: z.string().nullable(),
  financeApproverMembershipId: z.number().int().nullable(),
  financeApprovedAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});
