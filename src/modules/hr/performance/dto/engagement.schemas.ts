import { z } from "zod";

export const createFeedbackSchema = z.object({
  subjectUserId: z.string().min(1),
  reviewerUserId: z.string().min(1),
  type: z.enum(["SELF", "PEER", "MANAGER", "SKIP_LEVEL"]),
  cycleId: z.number().int().positive().optional(),
});

const feedbackRatingSchema = z.object({
  category: z.string().min(1),
  score: z.number().min(1).max(5),
  comment: z.string().optional(),
});

export const submitFeedbackSchema = z.object({
  ratings: z.array(feedbackRatingSchema).min(1),
  strengths: z.string().optional(),
  improvements: z.string().optional(),
  overallRating: z.number().int().min(1).max(5).optional(),
});

const assessmentQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string()).min(2),
  correctIndex: z.number().int().min(0),
});

export const createAssessmentSchema = z.object({
  title: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
  skillName: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  durationMinutes: z.number().int().positive().max(480).optional(),
  questions: z
    .preprocess((v) => (v == null ? [] : v), z.array(assessmentQuestionSchema))
    .optional()
    .default([]),
  passingScore: z.number().int().min(0).max(100).optional().default(70),
  timeLimit: z.number().int().positive().optional(),
});

export const submitAssessmentSchema = z.object({
  assessmentId: z.number().int().positive(),
  answers: z.array(
    z.object({
      questionId: z.string().min(1),
      selectedIndex: z.number().int().min(0),
    }),
  ),
});

export const createRecognitionSchema = z.object({
  toUserId: z.string().min(1, "Recipient is required"),
  message: z.string().min(10, "Message must be at least 10 characters").max(500),
  category: z
    .enum(["KUDOS", "TEAMWORK", "INNOVATION", "LEADERSHIP", "ABOVE_AND_BEYOND"])
    .optional()
    .default("KUDOS"),
});

export const createEnpsSchema = z.object({
  score: z.number().int().min(0).max(10),
  comment: z.string().optional(),
  isAnonymous: z.boolean().optional(),
});

export const createSurveySchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(2, "Title must be at least 2 characters")
      .max(100, "Title must be at most 100 characters"),
    questions: z
      .array(
        z.object({
          id: z.string().min(1),
          text: z.string().min(1),
          type: z.enum(["rating", "text", "choice"]),
          options: z.array(z.string()).optional(),
        }),
      )
      .min(1, "At least one question is required"),
    isAnonymous: z.boolean().optional().default(true),
    closesAt: z.string().optional(),
  })
  .refine((d) => !d.closesAt || new Date(d.closesAt) > new Date(), {
    message: "Closing date must be in the future",
    path: ["closesAt"],
  });

export const submitSurveyResponseSchema = z.object({
  surveyId: z.number().int().positive(),
  answers: z.array(
    z.object({
      questionId: z.string().min(1),
      value: z.union([z.string(), z.number()]),
    }),
  ),
});

export const updateSurveySchema = z.object({
  status: z.enum(["DRAFT", "ACTIVE", "CLOSED"]).optional(),
  title: z.string().min(1).max(200).optional(),
});

export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;
export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>;
export type CreateRecognitionInput = z.infer<typeof createRecognitionSchema>;
export type CreateEnpsInput = z.infer<typeof createEnpsSchema>;
export type CreateSurveyInput = z.infer<typeof createSurveySchema>;
export type UpdateSurveyInput = z.infer<typeof updateSurveySchema>;
