import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

/**
 * The deepest page KB search will serve. `pageNumberField` has no `.max()` — it is
 * `z.coerce.number().int().min(1).default(1)` — so `?page=100000000&pageSize=50` asked for
 * `OFFSET 5,000,000,000`, and the sort behind it is over the whole match set whatever the
 * offset. Measured on a 60,000-match tenant: `OFFSET 0` cost 35.5 ms, `OFFSET 59,980` cost
 * 55.5 ms and an external merge, from a GET needing only `kb:articles:view` — cheap
 * amplification for a scripted `page=` sweep.
 *
 * Clamped rather than rejected, which is how `pageSizeField` already treats an over-large
 * request: a bookmarked deep link gets the last page it is allowed instead of a 400. At the
 * 50-row ceiling this bounds the offset at 10,000; `total` is still exact, so a UI can say how
 * many results exist beyond it. The platform-wide `pageNumberField` is deliberately untouched
 * — every module shares it, and a ceiling there is a different change with a different owner.
 */
const KB_SEARCH_MAX_PAGE = 200;

export const searchSchema = z.object({
  q: z.string().trim().min(1).max(200),
  spaceId: z.coerce.number().int().positive().optional(),
  page: pageNumberField.transform((v) => Math.min(v, KB_SEARCH_MAX_PAGE)),
  pageSize: pageSizeField(20, 50),
}).strict();
export type SearchInput = z.infer<typeof searchSchema>;

export const askSchema = z.object({
  question: z.string().trim().min(3).max(1000),
  spaceId: z.coerce.number().int().positive().optional(),
  conversationId: z.coerce.number().int().positive().optional(),
}).strict();
export type AskInput = z.infer<typeof askSchema>;

export const kbAiAskBodySchema = z.object({
  question: z.string().trim().min(3).max(500),
}).strict();

/**
 * The four AI actions a KB document surface offers. Shared by the wiki page and
 * help-centre article controllers so the buffered route, its streaming sibling
 * and the frontend cannot drift onto different action names.
 */
export const kbDocAiActionSchema = z.enum(["summarize", "ask", "improve", "suggest-related"]);
export type KbDocAiAction = z.infer<typeof kbDocAiActionSchema>;

export const chatHistoryQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: pageSizeField(30, 100),
});

export const kbConversationCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
}).strict();

export const kbConversationRenameSchema = z.object({
  title: z.string().trim().min(1).max(200),
}).strict();

export const kbConversationsListQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: pageSizeField(20, 50),
});

export const kbConversationMessagesQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: pageSizeField(30, 100),
});

export const kbAiFeedbackSchema = z.object({
  rating: z.enum(["helpful", "not_helpful", "missing_source"]),
  question: z.string().trim().min(3).max(1000),
  comment: z.string().trim().max(500).optional(),
}).strict();
export type KbAiFeedbackInput = z.infer<typeof kbAiFeedbackSchema>;

export const kbResearchBriefCreateSchema = z.object({
  topic: z.string().trim().min(3).max(300),
  spaceId: z.coerce.number().int().positive().optional(),
}).strict();
export type KbResearchBriefCreateInput = z.infer<typeof kbResearchBriefCreateSchema>;

export const kbResearchBriefListSchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: pageSizeField(20, 100),
});
export type KbResearchBriefListInput = z.infer<typeof kbResearchBriefListSchema>;

export const kbResearchBriefRateSchema = z.object({
  rating: z.enum(["helpful", "not_helpful"]),
}).strict();
