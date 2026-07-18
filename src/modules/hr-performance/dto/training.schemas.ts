import { z } from "zod";

const trainingTypeEnum = z.string().max(50).optional();
const trainingFormatEnum = z.string().max(50).optional();
const trainingStatusEnum = z.string().max(50).optional();

export const createProgramSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  type: trainingTypeEnum,
  format: trainingFormatEnum,
  startDate: z.string().min(1),
  endDate: z.string().optional(),
  venue: z.string().max(500).optional(),
  virtualLink: z.string().url().optional().or(z.literal("")),
  maxCapacity: z.number().int().positive().optional(),
  instructorId: z.string().uuid().optional(),
  externalInstructor: z.string().max(200).optional(),
  isMandatory: z.boolean().optional(),
  status: trainingStatusEnum,
});
export type CreateProgramInput = z.infer<typeof createProgramSchema>;

export const updateProgramSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  type: trainingTypeEnum,
  format: trainingFormatEnum,
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  venue: z.string().max(500).optional(),
  virtualLink: z.string().url().optional().or(z.literal("")),
  maxCapacity: z.number().int().positive().optional(),
  instructorId: z.string().uuid().optional(),
  externalInstructor: z.string().max(200).optional(),
  isMandatory: z.boolean().optional(),
  status: trainingStatusEnum,
});
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>;

export const markAttendanceSchema = z.object({
  status: z.string().max(50).optional(),
  feedbackRating: z.number().int().min(1).max(5).optional(),
  feedbackText: z.string().max(2000).optional(),
  certificateUrl: z.string().url().optional().or(z.literal("")),
});
export type MarkAttendanceInput = z.infer<typeof markAttendanceSchema>;
