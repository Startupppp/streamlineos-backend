import { z } from "zod";

const titleSchema = z
  .string()
  .trim()
  .min(2, "Title must be at least 2 characters")
  .max(200, "Title must be at most 200 characters")
  .regex(/[a-zA-Z]/, "Title must contain at least one letter");

const contentSchema = z
  .string()
  .trim()
  .min(10, "Content must be at least 10 characters")
  .max(5000, "Content must be at most 5000 characters")
  .regex(/[a-zA-Z0-9]/, "Content must contain at least one letter or number");

const optionalDateTime = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v == null) return undefined;
    const trimmed = v.trim();
    return trimmed ? trimmed : undefined;
  })
  .refine(
    (v) => !v || !Number.isNaN(new Date(v).getTime()),
    "Enter a valid date and time",
  );

const announcementBodyBase = z.object({
  title: titleSchema,
  content: contentSchema,
  targetType: z.enum(["ALL", "DEPARTMENT", "BRANCH", "ROLE"]).default("ALL"),
  targetIds: z.array(z.string().min(1)).max(1000).default([]),
  status: z.enum(["DRAFT", "SCHEDULED", "PUBLISHED", "EXPIRED"]).default("DRAFT"),
  publishAt: optionalDateTime,
  expiresAt: optionalDateTime,
  isPinned: z.boolean().default(false),
  attachmentUrls: z.array(z.string()).default([]),
}).strict();

function refineAnnouncementDates(
  data: {
    status: string;
    publishAt?: string;
    expiresAt?: string;
    targetType: string;
    targetIds: string[];
  },
  ctx: z.RefinementCtx,
) {
  if (data.status === "EXPIRED") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Cannot set status to Expired — use an expiry date instead",
      path: ["status"],
    });
  }

  if (data.status === "SCHEDULED" && !data.publishAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Publish date is required for scheduled announcements",
      path: ["publishAt"],
    });
  }

  if (data.publishAt && data.expiresAt) {
    if (new Date(data.expiresAt).getTime() <= new Date(data.publishAt).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expiry must be after the publish date",
        path: ["expiresAt"],
      });
    }
  }

  if (data.targetType !== "ALL" && data.targetIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "At least one target is required when audience is not Everyone",
      path: ["targetIds"],
    });
  }
}

export const createHrAnnouncementSchema = announcementBodyBase.superRefine(refineAnnouncementDates);

export const updateHrAnnouncementSchema = announcementBodyBase
  .partial()
  .extend({
    title: titleSchema.optional(),
    content: contentSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.status === "EXPIRED") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cannot set status to Expired — use an expiry date instead",
        path: ["status"],
      });
    }
    if (data.status === "SCHEDULED" && data.publishAt === undefined) {
      // partial update may omit publishAt; only enforce when explicitly clearing or status alone
    }
    if (data.status === "SCHEDULED" && "publishAt" in data && !data.publishAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Publish date is required for scheduled announcements",
        path: ["publishAt"],
      });
    }
    if (data.publishAt && data.expiresAt) {
      if (new Date(data.expiresAt).getTime() <= new Date(data.publishAt).getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Expiry must be after the publish date",
          path: ["expiresAt"],
        });
      }
    }
    if (data.targetType && data.targetType !== "ALL" && data.targetIds && data.targetIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one target is required when audience is not Everyone",
        path: ["targetIds"],
      });
    }
  }).strict();

export type CreateHrAnnouncementInput = z.infer<typeof createHrAnnouncementSchema>;
export type UpdateHrAnnouncementInput = z.infer<typeof updateHrAnnouncementSchema>;
