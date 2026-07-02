import { z } from "zod";

export const createMilestoneSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["PENDING", "ACHIEVED", "MISSED"]).default("PENDING"),
});

export const updateMilestoneSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(["PENDING", "ACHIEVED", "MISSED"]).optional(),
});

export const createIntakeSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.unknown().optional(),
  source: z.enum(["manual", "web_form", "email"]).default("manual"),
  submitterEmail: z.string().email().optional(),
});

export const updateIntakeSchema = z.object({
  status: z.enum(["accepted", "declined", "duplicate"]).optional(),
  declineReason: z.string().min(1).optional(),
  linkedWorkItemId: z.number().optional(),
});

export const intakeListQuerySchema = z.object({
  status: z.enum(["pending", "accepted", "declined", "duplicate"]).optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const createViewSchema = z.object({
  name: z.string().min(1).max(100),
  filters: z.record(z.string(), z.unknown()).default({}),
  groupBy: z.string().optional(),
  orderBy: z.string().optional(),
  layoutType: z
    .enum(["board", "list", "table", "calendar", "gantt"])
    .default("board"),
  isPinned: z.boolean().default(false),
});

export const updateViewSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  groupBy: z.string().nullable().optional(),
  orderBy: z.string().nullable().optional(),
  layoutType: z.enum(["board", "list", "table", "calendar", "gantt"]).optional(),
  isPinned: z.boolean().optional(),
});

export const createWhiteboardSchema = z.object({
  name: z.string().min(1).max(200),
});

export const updateWhiteboardSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => value.name !== undefined || value.data !== undefined, {
    message: "Provide name or data to update",
  });

export const createPageSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.unknown().optional(),
  icon: z.string().optional(),
  parentPageId: z.number().optional(),
});

export const updatePageSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.unknown().optional(),
  icon: z.string().nullable().optional(),
  coverImage: z.string().nullable().optional(),
  isPublic: z.boolean().optional(),
  isPinned: z.boolean().optional(),
  parentPageId: z.number().nullable().optional(),
});

export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;
export type CreateIntakeInput = z.infer<typeof createIntakeSchema>;
export type UpdateIntakeInput = z.infer<typeof updateIntakeSchema>;
export type IntakeListQuery = z.infer<typeof intakeListQuerySchema>;
export type CreateViewInput = z.infer<typeof createViewSchema>;
export type UpdateViewInput = z.infer<typeof updateViewSchema>;
export type CreateWhiteboardInput = z.infer<typeof createWhiteboardSchema>;
export type UpdateWhiteboardInput = z.infer<typeof updateWhiteboardSchema>;
export type CreatePageInput = z.infer<typeof createPageSchema>;
export type UpdatePageInput = z.infer<typeof updatePageSchema>;
