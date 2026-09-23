import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const affectedTicketSummarySchema = z.object({
  id: z.number().int(),
  title: z.string(),
  ticketNumber: z.number().int(),
  status: z.string(),
  priority: z.string(),
  type: z.string(),
});

export const changeRequestAffectedItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  changeRequestId: z.number().int(),
  ticketId: z.number().int(),
  createdAt: wireDate(),
  createdBy: z.string().nullable(),
  ticket: affectedTicketSummarySchema,
});

export const changeRequestAffectedItemListPageSchema = cursorPageSchema(
  changeRequestAffectedItemSchema,
);
