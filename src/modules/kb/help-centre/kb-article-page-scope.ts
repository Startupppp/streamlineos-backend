import { eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import { kbPages, type KbPageContent } from "../../../db/schema";
import { paragraphize } from "./lib/kb-page-content";

export const SUPPORT_ARTICLE_CONTENT_TYPE = "support_article";

export const ARTICLE_VERIFIED_WINDOW_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

const VERIFIED_WINDOW_MS = ARTICLE_VERIFIED_WINDOW_DAYS * DAY_MS;

export type ArticleVisibility = "public" | "internal";

export type PageVisibility = "private" | "org" | "public";

export type PageTrustState = "unverified" | "verified" | "verification_expired";

export function supportArticlePredicate(): SQL {
  return sql`(${eq(kbPages.contentType, SUPPORT_ARTICLE_CONTENT_TYPE)} and ${isNull(kbPages.deletedAt)})`;
}

export function wikiPagePredicate(): SQL {
  return sql`(${isNull(kbPages.deletedAt)} and ${ne(kbPages.contentType, SUPPORT_ARTICLE_CONTENT_TYPE)})`;
}

export function wikiContentTypeOnly(): SQL {
  return ne(kbPages.contentType, SUPPORT_ARTICLE_CONTENT_TYPE);
}

export function articleVisibilityToPage(visibility: ArticleVisibility): PageVisibility {
  return visibility === "public" ? "public" : "org";
}

export function pageVisibilityToArticle(visibility: PageVisibility): ArticleVisibility {
  return visibility === "public" ? "public" : "internal";
}

export function articleVerifiedUntil(verifiedAt: Date): Date {
  return new Date(verifiedAt.getTime() + VERIFIED_WINDOW_MS);
}

export function articleNextReviewAt(
  verifiedAt: Date,
  reviewIntervalDays: number | null,
): Date | null {
  if (reviewIntervalDays === null) return null;
  return new Date(verifiedAt.getTime() + reviewIntervalDays * DAY_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonDocument(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toPageDocument(value: unknown): KbPageContent | null {
  if (isRecord(value)) return value;
  if (!Array.isArray(value)) return null;
  const items: unknown[] = value;
  const entries: Record<string, unknown>[] = [];
  for (const entry of items) {
    if (!isRecord(entry)) return null;
    entries.push(entry);
  }
  return entries;
}

export function articleContentToPageContent(
  content: string | undefined,
  contentText: string | undefined,
): KbPageContent {
  if (content !== undefined && content.trim() !== "") {
    return toPageDocument(parseJsonDocument(content)) ?? paragraphize(content);
  }
  return paragraphize(contentText ?? "");
}

export function pageContentToArticleContent(content: KbPageContent | null): string {
  return content === null ? "" : JSON.stringify(content);
}
