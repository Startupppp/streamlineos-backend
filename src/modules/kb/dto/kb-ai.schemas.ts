import { z } from "zod";

export const searchSchema = z.object({
  q: z.string().trim().min(1).max(200),
  spaceId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchInput = z.infer<typeof searchSchema>;

export const askSchema = z.object({
  question: z.string().trim().min(3).max(1000),
  spaceId: z.coerce.number().int().positive().optional(),
  conversationId: z.coerce.number().int().positive().optional(),
});
export type AskInput = z.infer<typeof askSchema>;

export const chatHistoryQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ChatHistoryQueryInput = z.infer<typeof chatHistoryQuerySchema>;

export const kbConversationCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});
export type KbConversationCreateInput = z.infer<typeof kbConversationCreateSchema>;

export const kbConversationRenameSchema = z.object({
  title: z.string().trim().min(1).max(200),
});
export type KbConversationRenameInput = z.infer<typeof kbConversationRenameSchema>;

export const kbConversationsListQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type KbConversationsListQueryInput = z.infer<typeof kbConversationsListQuerySchema>;

export const kbConversationMessagesQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type KbConversationMessagesQueryInput = z.infer<typeof kbConversationMessagesQuerySchema>;

export const kbAiFeedbackSchema = z.object({
  rating: z.enum(["helpful", "not_helpful", "missing_source"]),
  question: z.string().trim().min(3).max(1000),
  comment: z.string().trim().max(500).optional(),
});
export type KbAiFeedbackInput = z.infer<typeof kbAiFeedbackSchema>;

export const kbResearchBriefCreateSchema = z.object({
  topic: z.string().trim().min(3).max(300),
  spaceId: z.coerce.number().int().positive().optional(),
});
export type KbResearchBriefCreateInput = z.infer<typeof kbResearchBriefCreateSchema>;

export const kbResearchBriefListSchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type KbResearchBriefListInput = z.infer<typeof kbResearchBriefListSchema>;

export const kbResearchBriefRateSchema = z.object({
  rating: z.enum(["helpful", "not_helpful"]),
});
export type KbResearchBriefRateInput = z.infer<typeof kbResearchBriefRateSchema>;
