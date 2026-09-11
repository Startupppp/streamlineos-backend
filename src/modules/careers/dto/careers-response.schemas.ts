import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

const screeningQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  type: z.enum(["TEXT", "YES_NO", "SINGLE_SELECT", "NUMBER"]),
  required: z.boolean(),
  knockout: z.boolean(),
  knockoutAnswer: z.string().optional(),
  options: z.array(z.string()).optional(),
});

export const careersJobListSchema = z.array(
  z.object({
    id: z.number().int(),
    title: z.string(),
    location: z.string().nullable(),
    type: z.string(),
    experience: z.string().nullable(),
    description: z.string().nullable(),
    requirements: z.string().nullable(),
    benefits: z.string().nullable(),
    openings: z.number().int(),
    applicationDeadline: z.string().nullable(),
    screeningQuestions: z.array(screeningQuestionSchema).nullable(),
    createdAt: wireDate(),
  }),
);

export const careersApplyResponseSchema = z.object({
  id: z.string(),
  alreadyApplied: z.literal(true).optional(),
});
