import { z } from "zod";

export const createGoalSchema = z
  .object({
    userId: z.string().min(1, "Employee is required"),
    title: z
      .string()
      .trim()
      .min(2, "Title must be at least 2 characters")
      .max(100, "Title must be at most 100 characters")
      .regex(/[a-zA-Z]/, "Title must contain at least one letter")
      .refine((v) => !/\s{2,}/.test(v), "Cannot have consecutive spaces"),
    description: z
      .string()
      .trim()
      .max(1000, "Description must be at most 1000 characters")
      .optional(),
    type: z.string().optional(),
    targetValue: z
      .number()
      .positive("Target value must be greater than 0")
      .max(1000000, "Target value cannot exceed 1,000,000")
      .multipleOf(0.01),
    currentValue: z.number().min(0).optional().default(0),
    unit: z.string().max(50).optional(),
    startDate: z.string().min(1, "Start date is required"),
    endDate: z.string().min(1, "End date is required"),
    parentGoalId: z.number().optional(),
  })
  .refine((d) => new Date(d.endDate) > new Date(d.startDate), {
    message: "End date must be after start date",
    path: ["endDate"],
  });

export const updateGoalCollectionSchema = z.object({
  goalId: z.number(),
  title: z.string().optional(),
  description: z.string().optional(),
  targetValue: z.number().optional(),
  currentValue: z.number().optional(),
  status: z.string().optional(),
  progress: z.number().optional(),
});

export const updateGoalItemSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  targetValue: z.number().positive().optional(),
  currentValue: z.number().min(0).optional(),
  status: z.enum(["IN_PROGRESS", "COMPLETED", "CANCELLED"]).optional(),
  progress: z.number().min(0).max(100).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const createKeyResultSchema = z.object({
  goalId: z.number().int().positive(),
  title: z.string().min(1).max(200),
  targetValue: z.number().positive().optional(),
  unit: z.string().max(50).optional(),
});

export const updateKeyResultSchema = z.object({
  id: z.number().int().positive(),
  currentValue: z.number().min(0).optional(),
  progress: z.number().min(0).max(100).optional(),
});

export const createOneOnOneSchema = z
  .object({
    employeeId: z.string().min(1, "Employee is required"),
    scheduledAt: z.string().min(1, "Date/time is required"),
    duration: z
      .number()
      .int()
      .min(15, "Duration must be at least 15 minutes")
      .max(480, "Duration cannot exceed 480 minutes")
      .optional()
      .default(30),
    agenda: z
      .string()
      .trim()
      .min(5, "Agenda must be at least 5 characters")
      .max(1000, "Agenda must be at most 1000 characters"),
    meetingLink: z.string().url("Enter a valid URL").optional().or(z.literal("")),
  })
  .refine((d) => new Date(d.scheduledAt) > new Date(), {
    message: "Meeting must be scheduled in the future",
    path: ["scheduledAt"],
  });

export const updateOneOnOneSchema = z.object({
  scheduledAt: z.string().optional(),
  duration: z.number().int().min(15).max(180).optional(),
  status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED", "NO_SHOW"]).optional(),
  notes: z.string().max(5000).optional(),
  actionItems: z
    .array(z.object({ text: z.string().min(1), done: z.boolean() }))
    .optional(),
  agenda: z.string().max(1000).optional(),
  meetingLink: z.string().url().optional().or(z.literal("")),
});

const pipObjectiveSchema = z.object({
  objective: z
    .string()
    .trim()
    .min(3, "Objective must be at least 3 characters")
    .max(500, "Objective must be at most 500 characters"),
  metric: z
    .string()
    .trim()
    .min(3, "Success metric must be at least 3 characters")
    .max(200, "Success metric must be at most 200 characters"),
  deadline: z.string().min(1, "Deadline is required"),
});

export const createPipSchema = z
  .object({
    userId: z.string().min(1, "Employee is required"),
    hrRepId: z.string().optional(),
    reason: z
      .string()
      .trim()
      .min(10, "Reason must be at least 10 characters")
      .max(1000, "Reason must be at most 1000 characters"),
    objectives: z.array(pipObjectiveSchema).min(1, "At least one objective is required"),
    startDate: z.string().min(1, "Start date is required"),
    endDate: z.string().min(1, "End date is required"),
    notes: z.string().max(2000).optional(),
  })
  .refine((d) => new Date(d.endDate) > new Date(d.startDate), {
    message: "End date must be after start date",
    path: ["endDate"],
  })
  .refine((d) => !d.hrRepId || d.hrRepId !== d.userId, {
    message: "HR representative cannot be the same as the employee",
    path: ["hrRepId"],
  });

export const updatePipSchema = z.object({
  status: z.enum(["ACTIVE", "EXTENDED", "COMPLETED", "TERMINATED"]).optional(),
  outcome: z.string().max(1000).optional(),
  notes: z.string().max(2000).optional(),
  endDate: z.string().optional(),
  reason: z.string().min(1).max(1000).optional(),
  objectives: z.array(pipObjectiveSchema).optional(),
  hrRepId: z.string().nullable().optional(),
});

export const createReviewCycleSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(3, "Cycle name must be at least 3 characters")
      .max(100, "Cycle name must be at most 100 characters")
      .refine((v) => /[a-zA-Z0-9]/.test(v), "Cycle name must contain at least one letter or number")
      .refine((v) => !/\s{2,}/.test(v), "Cycle name cannot have consecutive spaces"),
    type: z.enum(["QUARTERLY", "HALF_YEARLY", "ANNUAL", "CUSTOM"]).optional().default("QUARTERLY"),
    periodStart: z.string().min(1, "Start date is required"),
    periodEnd: z.string().min(1, "End date is required"),
    deadline: z.string().min(1, "Deadline is required"),
    description: z.string().max(500).optional(),
  })
  .refine((d) => new Date(d.periodEnd) > new Date(d.periodStart), {
    message: "Period end must be after period start",
    path: ["periodEnd"],
  })
  .refine((d) => new Date(d.deadline) >= new Date(d.periodEnd), {
    message: "Submission deadline must be on or after period end",
    path: ["deadline"],
  });

export const createPerformanceReviewSchema = z
  .object({
    userId: z.string().min(1, "Employee is required"),
    reviewerId: z.string().optional(),
    cycleId: z.number().int().positive().optional(),
    periodStart: z.string().min(1, "Start date is required"),
    periodEnd: z.string().min(1, "End date is required"),
    ratings: z
      .array(
        z.object({
          category: z.string().min(1),
          score: z.number().min(0).max(10),
          comment: z.string().optional(),
        }),
      )
      .optional(),
    strengths: z.string().max(2000).optional(),
    improvements: z.string().max(2000).optional(),
    overallRating: z.number().min(0).max(10).optional(),
    comments: z.string().max(2000).optional(),
  })
  .refine((d) => new Date(d.periodEnd) > new Date(d.periodStart), {
    message: "Review end date must be after start date",
    path: ["periodEnd"],
  });

export const updatePerformanceReviewSchema = z.object({
  ratings: z
    .array(
      z.object({
        category: z.string().min(1),
        score: z.number().min(0).max(10),
        comment: z.string().optional(),
      }),
    )
    .optional(),
  strengths: z.string().max(2000).optional(),
  improvements: z.string().max(2000).optional(),
  overallRating: z.number().min(0).max(10).optional(),
  comments: z.string().max(2000).optional(),
  status: z.enum(["DRAFT", "IN_PROGRESS", "COMPLETED", "ARCHIVED"]).optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  cycleId: z.number().int().positive().optional(),
});

export const updateReviewCycleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.enum(["QUARTERLY", "HALF_YEARLY", "ANNUAL", "CUSTOM"]).optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  deadline: z.string().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"]).optional(),
  description: z.string().max(500).optional(),
});

export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalCollectionInput = z.infer<typeof updateGoalCollectionSchema>;
export type UpdateGoalItemInput = z.infer<typeof updateGoalItemSchema>;
export type CreateKeyResultInput = z.infer<typeof createKeyResultSchema>;
export type UpdateKeyResultInput = z.infer<typeof updateKeyResultSchema>;
export type CreateOneOnOneInput = z.infer<typeof createOneOnOneSchema>;
export type UpdateOneOnOneInput = z.infer<typeof updateOneOnOneSchema>;
export type CreatePipInput = z.infer<typeof createPipSchema>;
export type UpdatePipInput = z.infer<typeof updatePipSchema>;
export type UpdatePerformanceReviewInput = z.infer<typeof updatePerformanceReviewSchema>;
export type UpdateReviewCycleInput = z.infer<typeof updateReviewCycleSchema>;
export type CreateReviewCycleInput = z.infer<typeof createReviewCycleSchema>;
export type CreatePerformanceReviewInput = z.infer<typeof createPerformanceReviewSchema>;
