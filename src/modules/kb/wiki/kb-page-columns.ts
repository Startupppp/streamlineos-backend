import { getTableColumns } from "drizzle-orm";
import { kbPages } from "../../../db/schema";

/**
 * `fts` is the generated full-text tsvector. Nothing outside the search predicates reads it —
 * the frontend has zero references to the field — and PRD §5.1 forbids hydrating a vector into
 * a response. These are the only two column sets a kb_pages row leaves this module in.
 */
const { fts: _fts, ...detailColumns } = getTableColumns(kbPages);
const { content: _content, contentText: _contentText, ...listColumns } = detailColumns;

export const KB_PAGE_COLUMNS = detailColumns;
export const KB_PAGE_LIST_COLUMNS = listColumns;

export type KbPageRow = Omit<typeof kbPages.$inferSelect, "fts">;
export type KbPageListItem = Omit<KbPageRow, "content" | "contentText">;
