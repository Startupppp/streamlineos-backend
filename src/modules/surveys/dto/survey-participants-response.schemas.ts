import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

export const surveyParticipantRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  surveyId: z.number().int(),
  collectorId: z.number().int().nullable(),
  userId: z.string().nullable(),
  userMembershipId: z.number().int().nullable(),
  contactId: z.number().int().nullable(),
  leadId: z.number().int().nullable(),
  clientId: z.number().int().nullable(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  status: z.enum(["invited", "opened", "started", "completed", "unsubscribed", "bounced"]),
  accessTokenHash: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  invitedAt: nullableWireDate(),
  openedAt: nullableWireDate(),
  startedAt: nullableWireDate(),
  completedAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const surveyParticipantListSchema = z.object({
  items: z.array(surveyParticipantRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

export const surveyImportResultSchema = z.array(
  z.object({ id: z.number().int(), accessToken: z.string().nullable() }),
);

export const surveyInviteResultSchema = z.object({
  success: z.literal(true),
  count: z.number().int(),
});

export const surveyRemindResultSchema = z.object({
  success: z.literal(true),
  remindable: z.number().int(),
});
