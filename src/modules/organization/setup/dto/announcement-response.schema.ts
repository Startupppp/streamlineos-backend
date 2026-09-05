import { z } from "zod";

const responseDateSchema = z.union([z.date(), z.string().datetime()]);

export const announcementResponseSchema = z
  .object({
    id: z.number().int().positive(),
    orgId: z.string().min(1),
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(5_000),
    authorId: z.string().min(1),
    targetType: z.string().min(1).max(40),
    isPinned: z.boolean(),
    publishAt: responseDateSchema.nullable(),
    expiresAt: responseDateSchema.nullable(),
    status: z.string().min(1).max(40),
    readCount: z.number().int().nonnegative(),
    attachmentUrls: z.array(z.string().max(2_048)).max(100),
    createdAt: responseDateSchema,
    updatedAt: responseDateSchema,
    targetIds: z.array(z.string().min(1).max(255)).max(1_000),
  })
  .strict();

export const announcementListResponseSchema = z
  .array(announcementResponseSchema)
  .max(100);
