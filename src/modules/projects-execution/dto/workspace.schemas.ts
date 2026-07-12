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
  submitterName: z.string().max(200).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  requestType: z.enum(["bug", "feature", "task", "question", "other"]).optional(),
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

const MAX_DISPLAY_OPTIONS_BYTES = 8192;

const displayOptionsSchema = z
  .record(z.string(), z.unknown())
  .default({})
  .superRefine((val, ctx) => {
    if (JSON.stringify(val).length > MAX_DISPLAY_OPTIONS_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "displayOptions exceeds the 8KB limit" });
    }
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
  visibility: z.enum(["private", "shared"]).default("shared"),
  displayOptions: displayOptionsSchema,
});

export const updateViewSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  groupBy: z.string().nullable().optional(),
  orderBy: z.string().nullable().optional(),
  layoutType: z.enum(["board", "list", "table", "calendar", "gantt"]).optional(),
  isPinned: z.boolean().optional(),
  visibility: z.enum(["private", "shared"]).optional(),
  displayOptions: z
    .record(z.string(), z.unknown())
    .optional()
    .superRefine((val, ctx) => {
      if (val !== undefined && JSON.stringify(val).length > MAX_DISPLAY_OPTIONS_BYTES) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "displayOptions exceeds the 8KB limit" });
      }
    }),
});

export const createWhiteboardSchema = z.object({
  name: z.string().min(1).max(200),
});

const MAX_SCENE_BYTES = 2_000_000;

export const excalidrawSceneSchema = z
  .object({
    type: z.string().max(50).optional(),
    version: z.number().int().optional(),
    source: z.string().max(500).optional(),
    elements: z.array(z.record(z.string(), z.unknown())).max(5000),
    appState: z.record(z.string(), z.unknown()).optional(),
    files: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((scene) => JSON.stringify(scene).length <= MAX_SCENE_BYTES, {
    message: "Scene exceeds the 2MB limit",
  });

export const updateWhiteboardSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    data: excalidrawSceneSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.data !== undefined, {
    message: "Provide name or data to update",
  });

export const updateWhiteboardSharingSchema = z
  .object({
    visibility: z.enum(["project", "private", "public"]).optional(),
    publicAccess: z.enum(["viewer", "editor"]).optional(),
    linkExpiresAt: z.string().datetime().nullable().optional(),
    allowExport: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.visibility !== undefined ||
      v.publicAccess !== undefined ||
      v.linkExpiresAt !== undefined ||
      v.allowExport !== undefined,
    { message: "Provide at least one field to update" },
  );

export const setWhiteboardSharesSchema = z.object({
  shares: z
    .array(
      z.object({
        userId: z.string().min(1),
        role: z.enum(["viewer", "editor"]),
      }),
    )
    .max(100),
});

export const publicWhiteboardUpdateSchema = z.object({
  data: excalidrawSceneSchema,
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
export type ExcalidrawSceneInput = z.infer<typeof excalidrawSceneSchema>;
export type UpdateWhiteboardInput = z.infer<typeof updateWhiteboardSchema>;
export type UpdateWhiteboardSharingInput = z.infer<typeof updateWhiteboardSharingSchema>;
export type SetWhiteboardSharesInput = z.infer<typeof setWhiteboardSharesSchema>;
export type PublicWhiteboardUpdateInput = z.infer<typeof publicWhiteboardUpdateSchema>;
export type CreatePageInput = z.infer<typeof createPageSchema>;
export type UpdatePageInput = z.infer<typeof updatePageSchema>;
