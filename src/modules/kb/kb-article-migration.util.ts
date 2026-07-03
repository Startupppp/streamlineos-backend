import { kbArticles, kbPages } from "../../db/schema";

type ArticleRow = typeof kbArticles.$inferSelect;

export interface MappedPage {
  title: string;
  contentText: string | null;
  content: Record<string, unknown>;
  status: "published";
  contentType: "support_article";
  visibility: "org";
  trustState: "verified" | "unverified";
  ownerUserId: string | null;
  createdById: string | null;
  sourceArticleId: number;
  sortOrder: number;
  parentPageId: null;
}

export type PageInsert = typeof kbPages.$inferInsert;

const VERIFIED_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

export function paragraphize(contentText: string | null | undefined): Record<string, unknown> {
  const text = contentText?.trim() ?? "";
  if (!text) {
    return { type: "doc", content: [{ type: "p", children: [{ text: "" }] }] };
  }
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 500)
    .map((p) => ({ type: "p", children: [{ text: p }] }));
  return {
    type: "doc",
    content: paras.length ? paras : [{ type: "p", children: [{ text: "" }] }],
  };
}

export function mapArticleToPage(article: ArticleRow, sortOrder: number): MappedPage {
  const trustState =
    article.lastVerifiedAt != null &&
    Date.now() - article.lastVerifiedAt.getTime() <= VERIFIED_WINDOW_MS
      ? "verified"
      : "unverified";

  return {
    title: article.title,
    contentText: article.contentText || null,
    content: paragraphize(article.contentText),
    status: "published",
    contentType: "support_article",
    visibility: "org",
    trustState,
    ownerUserId: article.ownerId ?? null,
    createdById: article.authorId ?? article.ownerId ?? null,
    sourceArticleId: article.id,
    sortOrder,
    parentPageId: null,
  };
}
