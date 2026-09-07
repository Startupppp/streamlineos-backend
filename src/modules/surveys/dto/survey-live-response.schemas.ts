import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

export const surveyLiveSessionRowSchema = z.object({
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

export const liveSessionResultsSchema = z.object({
  participantCount: z.number().int(),
  revealed: z.boolean(),
  question: z.object({
    responseCount: z.number().int(),
    choiceDistribution: z.array(
      z.object({
        choiceId: z.number().int(),
        label: z.string(),
        count: z.number().int(),
        isCorrect: z.boolean(),
      }),
    ),
  }).nullable(),
});

export const joinLiveSessionSchema = z.object({
  participantToken: z.string(),
});

export const submitLiveAnswerSchema = z.object({ success: z.literal(true) });
