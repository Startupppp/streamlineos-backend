import { z } from "zod";

const citationFields = {
  title: z.string(), spaceId: z.number().int().nullable(), updatedAt: z.coerce.date(),
  passage: z.string().optional(),
  verified: z.boolean().optional(),
};

export const kbAskResultSchema = z.object({
  answer: z.string(),
  hasContext: z.boolean(),
  conversationId: z.number().int().positive(),
  citations: z.array(z.discriminatedUnion("kind", [
    z.object({ ...citationFields, kind: z.literal("article"), articleId: z.number().int().positive(), slug: z.string() }),
    z.object({ ...citationFields, kind: z.literal("page"), pageId: z.number().int().positive() }),
    z.object({ ...citationFields, kind: z.literal("source"), sourceId: z.number().int().positive() }),
    z.object({ ...citationFields, spaceId: z.null(), kind: z.literal("document"), linkedDocumentId: z.number().int().positive() }),
  ])),
  disagreement: z.object({ summary: z.string() }).optional(),
  aiUsage: z.object({
    model: z.string(), promptTokens: z.number(), completionTokens: z.number(), totalTokens: z.number(), credits: z.number(), costUsd: z.number(),
  }).optional(),
});
