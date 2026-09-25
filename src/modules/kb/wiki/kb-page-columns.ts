import { getTableColumns } from "drizzle-orm";
import { kbPages } from "../../../db/schema";

const { fts: _fts, ...detailColumns } = getTableColumns(kbPages);
const { content: _content, contentText: _contentText, ...listColumns } = detailColumns;

export const KB_PAGE_COLUMNS = detailColumns;
export const KB_PAGE_LIST_COLUMNS = listColumns;

export type KbPageRow = Omit<typeof kbPages.$inferSelect, "fts">;
export type KbPageListItem = Omit<KbPageRow, "content" | "contentText">;
