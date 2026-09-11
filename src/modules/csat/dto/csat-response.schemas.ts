import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { successSchema } from "../../../common/openapi/response-envelopes";

export const csatSurveyRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  clientId: z.number().int().nullable(),
  title: z.string(),
  question: z.string(),
  scaleMax: z.number().int(),
  status: z.string(),
  publicToken: z.string(),
  sentAt: nullableWireDate(),
  closedAt: nullableWireDate(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const csatResponseRowSchema = z.object({
  id: z.number().int(),
  surveyId: z.number().int(),
  orgId: z.string(),
  rating: z.number().int(),
  comment: z.string().nullable(),
  respondentName: z.string().nullable(),
  respondentEmail: z.string().nullable(),
  submittedAt: wireDate(),
});

export const csatSurveyListItemSchema = csatSurveyRowSchema.and(
  z.object({
    client: z.object({ id: z.number().int(), name: z.string() }).nullable(),
    responseCount: z.number().int(),
    avgRating: z.number().nullable(),
  }),
);

export const csatSurveyListSchema = z.array(csatSurveyListItemSchema);

export const csatSurveyDetailSchema = csatSurveyRowSchema.and(
  z.object({
    client: z.object({ id: z.number().int(), name: z.string() }).nullable(),
    responses: z.array(csatResponseRowSchema),
  }),
);

export const csatSubmittedSchema = z.object({ submitted: z.literal(true) });

export const csatResponseListSchema = z.array(csatResponseRowSchema);

export const csatByTokenSchema = z.object({
  ticketId: z.number().int().optional(),
  ticketTitle: z.string().optional(),
  alreadyResponded: z.boolean(),
});

export const csatSubmitResultSchema = z.object({
  success: z.literal(true),
  score: z.number().int(),
});

const csatSourceStatsSchema = z.object({
  totalRequests: z.number().int(),
  totalResponses: z.number().int(),
  responseRate: z.number(),
  averageScore: z.number().nullable(),
});

export const csatReportSchema = z.object({
  totalRequests: z.number().int(),
  totalResponses: z.number().int(),
  responseRate: z.number(),
  averageScore: z.number().nullable(),
  sources: z.object({
    ticket: csatSourceStatsSchema,
    crmCampaigns: csatSourceStatsSchema.nullable(),
    generalSurveys: z.union([
      csatSourceStatsSchema,
      z.object({ excluded: z.literal(true), reason: z.string() }),
    ]),
  }),
});

export { successSchema };
