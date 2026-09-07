import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const kbSettingsSchema = z.object({
  trashRetentionDays: z.number().int(),
  chatHistoryRetentionDays: z.number().int(),
});

export const kbTagSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: wireDate(),
});

export const kbTagListSchema = z.array(kbTagSchema);

export const kbTagSuccessSchema = z.object({ success: z.boolean() });

export const kbTranslationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  articleId: z.number().int(),
  locale: z.string(),
  title: z.string(),
  content: z.string(),
  contentText: z.string(),
  excerpt: z.string().nullable(),
  status: z.enum(["draft", "published", "archived"]),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const kbTranslationListSchema = z.array(kbTranslationSchema);

export const kbTranslationSuccessSchema = z.object({ success: z.boolean() });
