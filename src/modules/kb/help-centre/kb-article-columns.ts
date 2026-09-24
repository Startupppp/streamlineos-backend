import type { z } from "zod";
import { kbPages } from "../../../db/schema";
import {
  pageContentToArticleContent,
  pageVisibilityToArticle,
} from "./kb-article-page-scope";
import type {
  kbArticleFullSchema,
  kbArticleSchema,
  kbArticleWithTagsSchema,
} from "./dto/kb-helpcenter-response.schemas";

export const KB_ARTICLE_COLUMNS = {
  id: kbPages.id,
  orgId: kbPages.orgId,
  spaceId: kbPages.spaceId,
  categoryId: kbPages.categoryId,
  title: kbPages.title,
  slug: kbPages.slug,
  excerpt: kbPages.excerpt,
  content: kbPages.content,
  contentText: kbPages.contentText,
  status: kbPages.status,
  visibility: kbPages.visibility,
  createdById: kbPages.createdById,
  ownerMembershipId: kbPages.ownerMembershipId,
  trustState: kbPages.trustState,
  verifiedAt: kbPages.verifiedAt,
  views: kbPages.views,
  helpfulCount: kbPages.helpfulCount,
  notHelpfulCount: kbPages.notHelpfulCount,
  seoTitle: kbPages.seoTitle,
  seoDescription: kbPages.seoDescription,
  reviewIntervalDays: kbPages.reviewIntervalDays,
  publishedAt: kbPages.publishedAt,
  archivedAt: kbPages.archivedAt,
  createdAt: kbPages.createdAt,
  updatedAt: kbPages.updatedAt,
  aclRevision: kbPages.aclRevision,
  contentRevision: kbPages.contentRevision,
};

export type KbArticlePageRow = Pick<
  typeof kbPages.$inferSelect,
  keyof typeof KB_ARTICLE_COLUMNS
>;

export type KbArticleRow = z.infer<typeof kbArticleSchema>;

export type ArticleWithTags = z.infer<typeof kbArticleWithTagsSchema>;

export type ArticleWithCategory = z.infer<typeof kbArticleFullSchema>;

export function toArticleRow(page: KbArticlePageRow): KbArticleRow {
  return {
    id: page.id,
    orgId: page.orgId,
    categoryId: page.categoryId,
    spaceId: page.spaceId,
    ownerMembershipId: page.ownerMembershipId,
    title: page.title,
    slug: page.slug ?? "",
    excerpt: page.excerpt,
    content: pageContentToArticleContent(page.content),
    contentText: page.contentText ?? "",
    status: page.status,
    visibility: pageVisibilityToArticle(page.visibility),
    authorId: page.createdById,
    views: page.views ?? 0,
    helpfulCount: page.helpfulCount ?? 0,
    notHelpfulCount: page.notHelpfulCount ?? 0,
    seoTitle: page.seoTitle,
    seoDescription: page.seoDescription,
    reviewIntervalDays: page.reviewIntervalDays,
    lastVerifiedAt: page.verifiedAt,
    publishedAt: page.publishedAt,
    archivedAt: page.archivedAt,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    aclRevision: page.aclRevision,
    contentRevision: page.contentRevision,
  };
}
