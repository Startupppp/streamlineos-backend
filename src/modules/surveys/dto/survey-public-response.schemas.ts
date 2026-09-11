import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { successSchema } from "../../../common/openapi/response-envelopes";

export const surveyPublicSurveySchema = z.object({
  survey: z.object({
    id: z.number().int(),
    title: z.string(),
    description: z.string().nullable(),
    mode: z.enum(["survey", "assessment", "live_session", "lead_qualification", "custom"]),
    defaultLanguage: z.string(),
    branding: z.record(z.string(), z.unknown()),
    settings: z.record(z.string(), z.unknown()),
  }),
  schema: z.record(z.string(), z.unknown()).nullable(),
});

export const surveyResponseSessionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  surveyId: z.number().int(),
  versionId: z.number().int(),
  collectorId: z.number().int().nullable(),
  participantId: z.number().int().nullable(),
  anonymous: z.boolean(),
  startedAt: wireDate(),
  submittedAt: nullableWireDate(),
  durationSeconds: z.number().int().nullable(),
  score: z.number().int().nullable(),
  passed: z.boolean().nullable(),
  segment: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  status: z.enum(["in_progress", "submitted", "invalid", "excluded", "deleted_by_policy"]),
});

export const surveyPublicLiveSessionChoiceSchema = z.object({
  id: z.number().int(),
  choiceKey: z.string(),
  label: z.string(),
  value: z.string().nullable(),
  score: z.number().int().nullable(),
  sortOrder: z.number().int(),
});

const surveyLiveSessionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  surveyId: z.number().int(),
  versionId: z.number().int(),
  hostUserId: z.string().nullable(),
  hostMembershipId: z.number().int().nullable(),
  sessionCode: z.string(),
  status: z.enum(["draft", "waiting", "active", "paused", "ended"]),
  currentQuestionId: z.number().int().nullable(),
  startedAt: nullableWireDate(),
  endedAt: nullableWireDate(),
  settings: z.record(z.string(), z.unknown()),
  createdAt: wireDate(),
});

export const surveyPublicLiveSessionSchema = surveyLiveSessionRowSchema.and(
  z.object({
    currentQuestion: z.object({
      id: z.number().int(),
      questionKey: z.string(),
      type: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      required: z.boolean(),
      settings: z.record(z.string(), z.unknown()),
      choices: z.array(surveyPublicLiveSessionChoiceSchema),
    }).nullable(),
  }),
);

export const joinLiveSessionResultSchema = z.object({ participantToken: z.string() });

export const submitLiveAnswerSchema = z.object({ success: z.literal(true) });

export { successSchema };
