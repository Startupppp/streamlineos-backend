import { z } from "zod";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date");

const PROGRAM_TYPES = ["MANDATORY", "OPTIONAL", "COMPLIANCE"] as const;
const PROGRAM_FORMATS = ["CLASSROOM", "VIRTUAL", "BLENDED", "SELF_PACED"] as const;
const PROGRAM_STATUSES = ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
const ATTENDANCE_STATUSES = ["ENROLLED", "ATTENDED", "ABSENT", "CANCELLED"] as const;

export const createTrainingProgramSchema = z
  .object({
    name: z.string().trim().min(1, "Program name is required").max(200, "Program name must be at most 200 characters"),
    description: z.string().trim().max(5000, "Description must be at most 5000 characters").optional(),
    type: z.enum(PROGRAM_TYPES).optional().default("MANDATORY"),
    format: z.enum(PROGRAM_FORMATS).optional().default("CLASSROOM"),
    startDate: dateOnly,
    endDate: dateOnly.optional(),
    venue: z.string().trim().max(200, "Venue must be at most 200 characters").optional(),
    virtualLink: z.string().trim().url("Enter a valid URL").max(2000).optional().or(z.literal("")),
    maxCapacity: z.coerce.number().int().positive().optional(),
    instructorId: z.string().trim().min(1, "Instructor is required").optional(),
    externalInstructor: z.string().trim().max(200, "Instructor name must be at most 200 characters").optional(),
    isMandatory: z.boolean().optional().default(false),
    status: z.enum(PROGRAM_STATUSES).optional().default("SCHEDULED"),
  })
  .refine((d) => !d.endDate || d.endDate >= d.startDate, {
    message: "End date must be on or after start date",
    path: ["endDate"],
  });

export const updateTrainingProgramSchema = z.object({
  name: z.string().trim().min(1).max(200, "Program name must be at most 200 characters").optional(),
  description: z.string().trim().max(5000, "Description must be at most 5000 characters").optional(),
  type: z.enum(PROGRAM_TYPES).optional(),
  format: z.enum(PROGRAM_FORMATS).optional(),
  startDate: dateOnly.optional(),
  endDate: dateOnly.optional(),
  venue: z.string().trim().max(200, "Venue must be at most 200 characters").optional(),
  virtualLink: z.string().trim().url("Enter a valid URL").max(2000).optional().or(z.literal("")),
  maxCapacity: z.coerce.number().int().positive().optional(),
  instructorId: z.string().trim().min(1, "Instructor is required").optional(),
  externalInstructor: z.string().trim().max(200, "Instructor name must be at most 200 characters").optional(),
  isMandatory: z.boolean().optional(),
  status: z.enum(PROGRAM_STATUSES).optional(),
});

export const markAttendanceSchema = z.object({
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  feedbackRating: z.coerce
    .number()
    .int()
    .min(1, "Rating must be between 1 and 5")
    .max(5, "Rating must be between 1 and 5")
    .optional(),
  feedbackText: z.string().trim().max(2000, "Feedback must be at most 2000 characters").optional(),
  certificateUrl: z.string().trim().url("Enter a valid URL").max(2000).optional().or(z.literal("")),
});

export type CreateTrainingProgramInput = z.infer<typeof createTrainingProgramSchema>;
export type UpdateTrainingProgramInput = z.infer<typeof updateTrainingProgramSchema>;
export type MarkAttendanceInput = z.infer<typeof markAttendanceSchema>;
