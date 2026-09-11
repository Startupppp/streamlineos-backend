import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

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

export const surveyResponseListSchema = z.object({
  items: z.array(surveyResponseSessionRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

const surveyAnswerRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  sessionId: z.number().int(),
  surveyId: z.number().int(),
  versionId: z.number().int(),
  questionId: z.number().int(),
  answerValue: z.unknown().nullable(),
  answerText: z.string().nullable(),
  choiceIds: z.array(z.number().int()).nullable(),
  score: z.number().int().nullable(),
  answeredAt: wireDate(),
  question: z.object({
    id: z.number().int(),
    questionKey: z.string(),
    type: z.string(),
    title: z.string(),
    choices: z.array(z.object({
      id: z.number().int(),
      choiceKey: z.string(),
      label: z.string(),
      sortOrder: z.number().int(),
    })),
  }).optional(),
});

export const surveyResponseDetailSchema = z.object({
  session: surveyResponseSessionRowSchema,
  answers: z.array(surveyAnswerRowSchema),
});


export const surveyOverviewSchema = z.object({
  totalResponses: z.number().int(),
  submittedResponses: z.number().int(),
  completionRate: z.number(),
  averageCompletionTimeSeconds: z.number().nullable(),
  averageScore: z.number().nullable(),
  totalParticipants: z.number().int(),
});

export const surveyQuestionAnalyticsSchema = z.array(
  z.object({
    questionId: z.number().int(),
    type: z.string(),
    title: z.string(),
    responseCount: z.number().int(),
    average: z.number().nullable(),
    choiceDistribution: z.array(
      z.object({
        choiceId: z.number().int(),
        label: z.string(),
        count: z.number().int(),
      }),
    ),
    textResponses: z.array(z.string().nullable()).optional(),
  }),
);
