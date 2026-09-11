import { kbArticles } from "../../../db/schema";

/**
 * Exactly the columns the mapping reads, rather than the whole row. Depending on
 * `$inferSelect` made every new column on `kb_articles` a compile error in this
 * util's tests, which is a lot of churn for a function that touches six fields.
 *
 * `visibility` is listed although the mapping ignores it: a support article is
 * always published to the org, whatever it was before, and the tests assert that
 * collapse. Dropping it from the type would make those cases unwritable.
 */
type ArticleRow = Pick<
  typeof kbArticles.$inferSelect,
  "id" | "title" | "contentText" | "lastVerifiedAt" | "ownerMembershipId" | "authorId" | "visibility"
> & { ownerId?: string | null };

export interface MappedPage {
  title: string;
  contentText: string | null;
  content: Record<string, unknown>;
  status: "published";
  contentType: "support_article";
  visibility: "org";
  trustState: "verified" | "unverified";
  ownerUserId: string | null;
  ownerMembershipId: number | null;
  createdById: string | null;
  sourceArticleId: number;
  sortOrder: number;
  parentPageId: null;
}

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
    ownerMembershipId: article.ownerMembershipId ?? null,
    createdById: article.authorId ?? article.ownerId ?? null,
    sourceArticleId: article.id,
    sortOrder,
    parentPageId: null,
  };
}
