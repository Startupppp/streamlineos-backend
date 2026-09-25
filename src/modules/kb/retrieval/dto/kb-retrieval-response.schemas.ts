import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const kbAskCitationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("article"),
    articleId: z.number().int(),
    slug: z.string(),
    title: z.string(),
    spaceId: z.number().int().nullable(),
    updatedAt: wireDate(),
  }),
  z.object({
    kind: z.literal("page"),
    pageId: z.number().int(),
    title: z.string(),
    spaceId: z.number().int().nullable(),
    updatedAt: wireDate(),
  }),
  z.object({
    kind: z.literal("source"),
    sourceId: z.number().int(),
    title: z.string(),
    spaceId: z.number().int().nullable(),
    updatedAt: wireDate(),
  }),
  z.object({
    kind: z.literal("document"),
    linkedDocumentId: z.number().int(),
    title: z.string(),
    spaceId: z.null(),
    updatedAt: wireDate(),
  }),
]);

export const kbAskAnswerSchema = z.object({
  answer: z.string(),
  hasContext: z.boolean(),
  citations: z.array(kbAskCitationSchema),
  conversationId: z.number().int(),
});

const kbChatMessageSchema = z.object({
  id: z.number().int(),
  role: z.string(),
  content: z.string(),
  citations: z.array(kbAskCitationSchema).nullable(),
  createdAt: z.string(),
});

export const kbChatHistoryPageSchema = z.object({
  messages: z.array(kbChatMessageSchema),
  nextCursor: z.number().int().nullable(),
});

export const kbChatSuccessSchema = z.object({ success: z.boolean() });

const kbConversationSchema = z.object({
  id: z.number().int(),
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const kbConversationListPageSchema = z.object({
  conversations: z.array(kbConversationSchema),
  nextCursor: z.number().int().nullable(),
});

export const kbConversationResponseSchema = kbConversationSchema;

export const kbSearchItemSchema = z.object({
  id: z.number().int(),
  spaceId: z.number().int().nullable(),
  categoryId: z.number().int().nullable(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string().nullable(),
  status: z.string(),
  updatedAt: wireDate(),
  snippet: z.string(),
});

export const kbSearchResponseSchema = z.object({
  items: z.array(kbSearchItemSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

export const kbReindexPageSchema = z.object({ reindexed: z.boolean() });

export const kbReindexAllSchema = z.object({
  reindexed: z.number().int(),
  nextPageId: z.number().int().nullable(),
});

const kbBriefSummarySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string().nullable(),
  topic: z.string(),
  spaceId: z.number().int().nullable(),
  status: z.enum(["queued", "running", "completed", "failed"]),
  jobId: z.number().int().nullable(),
  sourceCount: z.number().int(),
  errorMessage: z.string().nullable(),
  rating: z.enum(["helpful", "not_helpful"]).nullable(),
  costCredits: z.number().int().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const kbResearchBriefEnqueueSchema = z.object({
  briefId: z.number().int(),
  jobId: z.number().int(),
});

export const kbResearchBriefListSchema = z.object({
  items: z.array(kbBriefSummarySchema),
  nextCursor: z.number().int().nullable(),
});

export const kbResearchBriefDetailSchema = kbBriefSummarySchema.extend({
  report: z.string().nullable(),
  citations: z
    .array(
      z.object({
        kind: z.string(),
        id: z.number().int(),
        title: z.string(),
        href: z.string().nullable(),
        updatedAt: z.string().nullable(),
      }),
    )
    .nullable(),
});

export const kbResearchBriefRateSchema = z.object({ success: z.literal(true) });
