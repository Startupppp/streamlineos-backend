import { z } from "zod";

const citationFields = {
  title: z.string(), spaceId: z.number().int().nullable(), updatedAt: z.coerce.date(),
};

export const kbAskResultSchema = z.object({
  answer: z.string(),
  hasContext: z.boolean(),
  conversationId: z.number().int().positive(),
  citations: z.array(z.discriminatedUnion("kind", [
    z.object({ ...citationFields, kind: z.literal("article"), articleId: z.number().int().positive(), slug: z.string() }).strict(),
    z.object({ ...citationFields, kind: z.literal("page"), pageId: z.number().int().positive() }).strict(),
    z.object({ ...citationFields, kind: z.literal("source"), sourceId: z.number().int().positive() }).strict(),
  ])),
  aiUsage: z.object({
    model: z.string(), promptTokens: z.number(), completionTokens: z.number(), totalTokens: z.number(), credits: z.number(), costUsd: z.number(),
  }).strict().optional(),
}).strict();
