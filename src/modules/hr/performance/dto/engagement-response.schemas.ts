import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

const feedbackRequestSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  subjectUserId: z.string(),
  subjectMembershipId: z.number().int().nullable(),
  reviewerUserId: z.string(),
  reviewerMembershipId: z.number().int().nullable(),
  type: z.enum(["SELF", "PEER", "MANAGER", "DIRECT_REPORT"]),
  cycleId: z.number().int().nullable(),
  ratings: z.array(z.object({ category: z.string(), score: z.number(), comment: z.string().optional() })).nullable(),
  strengths: z.string().nullable(),
  improvements: z.string().nullable(),
  overallRating: z.number().int().nullable(),
  isCompleted: z.boolean(),
  completedAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const listFeedbackResponseSchema = z.array(feedbackRequestSchema);
export const createFeedbackResponseSchema = feedbackRequestSchema;
export const submitFeedbackResponseSchema = feedbackRequestSchema;

const assessmentAttemptSchema = z.object({
  id: z.number().int(),
  orgId: z.string().nullable(),
  assessmentId: z.number().int(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  answers: z.array(z.object({ questionId: z.string(), selectedIndex: z.number().int() })).nullable(),
  score: z.number().int().nullable(),
  passed: z.boolean(),
  completedAt: wireDate(),
});

const assessmentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  skillName: z.string(),
  questions: z.array(z.object({ id: z.string(), question: z.string(), options: z.array(z.string()), correctIndex: z.number().int() })).nullable(),
  passingScore: z.number().int(),
  timeLimit: z.number().int().nullable(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  attempts: z.array(assessmentAttemptSchema),
});

export const listAssessmentsResponseSchema = z.array(assessmentSchema);

export const createOrSubmitAssessmentResponseSchema = z.union([
  assessmentSchema.omit({ attempts: true }),
  assessmentAttemptSchema.extend({ score: z.number().int(), passed: z.boolean(), correct: z.number().int(), total: z.number().int() }),
]);

const userMinSchema = z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable(), image: z.string().nullable() });

const recognitionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  fromUserId: z.string(),
  fromMembershipId: z.number().int().nullable(),
  toUserId: z.string(),
  toMembershipId: z.number().int().nullable(),
  message: z.string(),
  category: z.string(),
  isPublic: z.boolean(),
  createdAt: wireDate(),
  fromUser: userMinSchema,
  toUser: userMinSchema,
});

export const listRecognitionsResponseSchema = z.array(recognitionSchema);
export const createRecognitionResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  fromUserId: z.string(),
  fromMembershipId: z.number().int().nullable(),
  toUserId: z.string(),
  toMembershipId: z.number().int().nullable(),
  message: z.string(),
  category: z.string(),
  isPublic: z.boolean(),
  createdAt: wireDate(),
});

const enpsSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string().nullable(),
  userMembershipId: z.number().int().nullable(),
  score: z.number().int(),
  comment: z.string().nullable(),
  isAnonymous: z.boolean(),
  period: z.string().nullable(),
  createdAt: wireDate(),
});

export const listEnpsResponseSchema = z.array(enpsSchema);
export const createEnpsResponseSchema = enpsSchema;

const surveySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  questions: z.array(z.object({ id: z.string(), text: z.string(), type: z.enum(["rating", "text", "choice"]), options: z.array(z.string()).optional() })).nullable(),
  status: z.enum(["DRAFT", "ACTIVE", "CLOSED"]),
  isAnonymous: z.boolean(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  closesAt: nullableWireDate(),
  createdAt: wireDate(),
  responses: z.array(z.object({
    id: z.number().int(),
    orgId: z.string().nullable(),
    surveyId: z.number().int(),
    userId: z.string().nullable(),
    userMembershipId: z.number().int().nullable(),
    answers: z.array(z.object({ questionId: z.string(), value: z.union([z.string(), z.number()]) })).nullable(),
    submittedAt: wireDate(),
  })),
});

const surveyResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string().nullable(),
  surveyId: z.number().int(),
  userId: z.string().nullable(),
  userMembershipId: z.number().int().nullable(),
  answers: z.array(z.object({ questionId: z.string(), value: z.union([z.string(), z.number()]) })).nullable(),
  submittedAt: wireDate(),
});

export const listSurveysResponseSchema = z.array(surveySchema);

export const createOrRespondSurveyResponseSchema = z.union([
  surveySchema.omit({ responses: true }),
  surveyResponseSchema,
]);

export const updateSurveyResponseSchema = successSchema;
