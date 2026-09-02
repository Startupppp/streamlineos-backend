import { getTableColumns } from "drizzle-orm";
import { kbArticles } from "../../../db/schema";

/**
 * `fts` is the generated full-text tsvector. Only the search predicates in kb/retrieval read it,
 * the frontend has zero references to the field, and PRD §5.1 forbids hydrating a vector into a
 * response. This is the column set a kb_articles row leaves this module in.
 */
const { fts: _fts, ...articleColumns } = getTableColumns(kbArticles);

export const KB_ARTICLE_COLUMNS = articleColumns;

export type KbArticleRow = Omit<typeof kbArticles.$inferSelect, "fts">;
