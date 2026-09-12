import { z } from "zod";

const sprintNameSchema = z
  .string()
  .transform((v) => v.trim())
  .pipe(
    z
      .string()
      .min(2, "Sprint name must be at least 2 characters")
      .max(100, "Sprint name must be 100 characters or fewer")
      .regex(
        /[A-Za-z0-9]/,
        "Sprint name must contain at least one letter or number",
      ),
  );

export const createSprintSchema = z
  .object({
    name: sprintNameSchema,
    startDate: z.string().min(1, "Start date is required"),
    endDate: z.string().min(1, "End date is required"),
    goal: z.string().optional(),
  }).strict()
  .superRefine((data, ctx) => {
    if (data.startDate && data.endDate && data.endDate <= data.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "End date must be after start date",
        path: ["endDate"],
      });
    }
  });

export const updateSprintSchema = z
  .object({
    name: sprintNameSchema.optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    goal: z.string().optional(),
    status: z.enum(["PLANNED", "ACTIVE", "COMPLETED"]).optional(),
  }).strict()
  .superRefine((data, ctx) => {
    if (data.startDate && data.endDate && data.endDate <= data.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "End date must be after start date",
        path: ["endDate"],
      });
    }
  });

const cycleNameSchema = z
  .string()
  .transform((v) => v.trim())
  .pipe(
    z
      .string()
      .min(2, "Name must be at least 2 characters")
      .max(100, "Name must be 100 characters or fewer")
      .regex(/[A-Za-z0-9]/, "Name must contain at least one letter or number"),
  );

export const createCycleSchema = z
  .object({
    name: cycleNameSchema,
    description: z
      .string()
      .max(500, "Description must be 500 characters or fewer")
      .optional(),
    startDate: z.string().min(1, "Start date is required"),
    endDate: z.string().min(1, "End date is required"),
  }).strict()
  .superRefine((data, ctx) => {
    if (data.startDate && data.endDate && data.endDate <= data.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "End date must be after start date",
        path: ["endDate"],
      });
    }
  });

export const updateCycleSchema = z
  .object({
    name: cycleNameSchema.optional(),
    description: z
      .string()
      .max(500, "Description must be 500 characters or fewer")
      .optional(),
    status: z.enum(["draft", "active", "completed"]).optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  }).strict()
  .superRefine((data, ctx) => {
    if (data.startDate && data.endDate && data.endDate <= data.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "End date must be after start date",
        path: ["endDate"],
      });
    }
  });

export const cycleListQuerySchema = z.object({
  status: z.enum(["draft", "active", "completed"]).optional(),
}).strict();

const moduleNameSchema = z
  .string()
  .transform((v) => v.trim())
  .pipe(
    z
      .string()
      .min(2, "Module name must be at least 2 characters")
      .max(80, "Module name must be 80 characters or fewer")
      .regex(
        /[A-Za-z0-9]/,
        "Module name must contain at least one letter or number",
      ),
  );

export const createModuleSchema = z
  .object({
    name: moduleNameSchema,
    description: z
      .string()
      .max(500, "Description must be 500 characters or fewer")
      .optional(),
    status: z
      .enum([
        "backlog",
        "planned",
        "in-progress",
        "completed",
        "paused",
        "cancelled",
      ])
      .default("backlog"),
    leadId: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  }).strict()
  .superRefine((data, ctx) => {
    if (data.startDate && data.endDate && data.endDate <= data.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "End date must be after start date",
        path: ["endDate"],
      });
    }
  });

export const updateModuleSchema = z
  .object({
    name: moduleNameSchema.optional(),
    description: z
      .string()
      .max(500, "Description must be 500 characters or fewer")
      .optional(),
    status: z
      .enum([
        "backlog",
        "planned",
        "in-progress",
        "completed",
        "paused",
        "cancelled",
      ])
      .optional(),
    leadId: z.string().nullable().optional(),
    startDate: z.string().nullable().optional(),
    endDate: z.string().nullable().optional(),
  }).strict()
  .superRefine((data, ctx) => {
    if (data.startDate && data.endDate && data.endDate <= data.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "End date must be after start date",
        path: ["endDate"],
      });
    }
  });

export const createEpicSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  startDate: z.string().optional(),
  dueDate: z.string().optional(),
  points: z.number().optional(),
}).strict();

export const updateEpicSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  assigneeId: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  points: z.number().nullable().optional(),
}).strict();

export type CreateEpicInput = z.infer<typeof createEpicSchema>;
export type UpdateEpicInput = z.infer<typeof updateEpicSchema>;
export type CreateCycleInput = z.infer<typeof createCycleSchema>;
export type UpdateCycleInput = z.infer<typeof updateCycleSchema>;
export type CycleListQuery = z.infer<typeof cycleListQuerySchema>;
export type CreateModuleInput = z.infer<typeof createModuleSchema>;
export type UpdateModuleInput = z.infer<typeof updateModuleSchema>;
export type CreateSprintInput = z.infer<typeof createSprintSchema>;
export type UpdateSprintInput = z.infer<typeof updateSprintSchema>;

export const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
export const projectAndSprintIdParams = z.object({ projectId: z.coerce.number().int().positive(), sprintId: z.coerce.number().int().positive() }).strict();
export const projectAndCycleIdParams = z.object({ projectId: z.coerce.number().int().positive(), cycleId: z.coerce.number().int().positive() }).strict();
export const projectAndModuleIdParams = z.object({ projectId: z.coerce.number().int().positive(), moduleId: z.coerce.number().int().positive() }).strict();
export const projectAndEpicIdParams = z.object({ projectId: z.coerce.number().int().positive(), epicId: z.coerce.number().int().positive() }).strict();
