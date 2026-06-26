import { z } from "zod";

export const interviewQuestionListQuerySchema = z.object({
  category: z.string().optional(),
  role: z.string().optional(),
  difficulty: z.string().optional(),
  q: z.string().optional(),
});

export const createInterviewQuestionSchema = z.object({
  question: z.string().min(1).max(300),
  category: z.string().min(1).max(100).default("GENERAL"),
  role: z.string().max(100).optional(),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).default("MEDIUM"),
  tags: z.array(z.string().max(100)).max(5).default([]),
  sampleAnswer: z.string().max(200).optional(),
  keywords: z.array(z.string().max(100)).max(5).default([]),
});

export const updateInterviewQuestionSchema = z.object({
  question: z.string().min(1).max(300).optional(),
  category: z.string().min(1).max(100).optional(),
  role: z.string().max(100).nullable().optional(),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).optional(),
  tags: z.array(z.string().max(100)).max(5).optional(),
  sampleAnswer: z.string().max(200).nullable().optional(),
  keywords: z.array(z.string().max(100)).max(5).optional(),
  isActive: z.boolean().optional(),
});

export type InterviewQuestionListQuery = z.infer<typeof interviewQuestionListQuerySchema>;
export type CreateInterviewQuestionInput = z.infer<typeof createInterviewQuestionSchema>;
export type UpdateInterviewQuestionInput = z.infer<typeof updateInterviewQuestionSchema>;
