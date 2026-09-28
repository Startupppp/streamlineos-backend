import { z } from "zod";
import {
  pageSizeField,
} from "../../../../common/pagination/list-query.schema";

export const searchSchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    spaceId: z.coerce.number().int().positive().optional(),
    pageSize: pageSizeField(20, 50),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type SearchInput = z.infer<typeof searchSchema>;

export const askSchema = z
  .object({
    question: z.string().trim().min(3).max(1000),
    spaceId: z.coerce.number().int().positive().optional(),
    conversationId: z.coerce.number().int().positive().optional(),
    sourceIds: z
      .array(z.coerce.number().int().positive())
      .min(1)
      .max(50)
      .optional(),
    pageIds: z
      .array(z.coerce.number().int().positive())
      .min(1)
      .max(50)
      .optional(),
    verifiedOnly: z.boolean().optional(),
  })
  .strict();
export type AskInput = z.infer<typeof askSchema>;

export const kbAiAskBodySchema = z
  .object({
    question: z.string().trim().min(3).max(500),
  })
  .strict();

export const kbDocAiActionSchema = z.enum([
  "summarize",
  "ask",
  "improve",
  "suggest-related",
]);
export type KbDocAiAction = z.infer<typeof kbDocAiActionSchema>;

export const chatHistoryQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: pageSizeField(30, 100),
});

export const kbConversationCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const kbConversationRenameSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
  })
  .strict();

export const kbConversationsListQuerySchema = z
  .object({
    cursor: z.coerce.number().int().positive().optional(),
    limit: pageSizeField(20, 50),
    q: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const kbConversationMessagesQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: pageSizeField(30, 100),
});

export const kbAiFeedbackSchema = z
  .object({
    rating: z.enum(["helpful", "not_helpful", "missing_source"]),
    question: z.string().trim().min(3).max(1000),
    comment: z.string().trim().max(500).optional(),
  })
  .strict();
export type KbAiFeedbackInput = z.infer<typeof kbAiFeedbackSchema>;

export const kbCreateKnowledgeGapSchema = z
  .object({
    question: z.string().trim().min(3).max(1000),
  })
  .strict();
export type KbCreateKnowledgeGapInput = z.infer<typeof kbCreateKnowledgeGapSchema>;

export const kbResearchBriefCreateSchema = z
  .object({
    topic: z.string().trim().min(3).max(300),
    spaceId: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type KbResearchBriefCreateInput = z.infer<
  typeof kbResearchBriefCreateSchema
>;

export const kbResearchBriefListSchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: pageSizeField(20, 100),
}).strict();
export type KbResearchBriefListInput = z.infer<
  typeof kbResearchBriefListSchema
>;

export const kbResearchBriefRateSchema = z
  .object({
    rating: z.enum(["helpful", "not_helpful"]),
  })
  .strict();
