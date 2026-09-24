export interface ArticleParityFields {
  slug: string | null;
  title: string;
  excerpt: string | null;
  views: number;
  helpfulCount: number;
  notHelpfulCount: number;
  seoTitle: string | null;
  seoDescription: string | null;
  reviewIntervalDays: number | null;
  publishedAt: Date | null;
  archivedAt: Date | null;
}

export interface PageParityFields {
  slug: string | null;
  title: string;
  excerpt: string | null;
  views: number | null;
  helpfulCount: number | null;
  notHelpfulCount: number | null;
  seoTitle: string | null;
  seoDescription: string | null;
  reviewIntervalDays: number | null;
  publishedAt: Date | null;
  archivedAt: Date | null;
}

export interface ParityMismatch {
  column: string;
  articleValue: unknown;
  pageValue: unknown;
}

export function findParityMismatches(
  article: ArticleParityFields,
  page: PageParityFields,
): ParityMismatch[] {
  const checks: Array<[string, unknown, unknown]> = [
    ["slug", article.slug, page.slug],
    ["title", article.title, page.title],
    ["excerpt", article.excerpt, page.excerpt],
    ["views", article.views, page.views],
    ["helpfulCount", article.helpfulCount, page.helpfulCount],
    ["notHelpfulCount", article.notHelpfulCount, page.notHelpfulCount],
    ["seoTitle", article.seoTitle, page.seoTitle],
    ["seoDescription", article.seoDescription, page.seoDescription],
    ["reviewIntervalDays", article.reviewIntervalDays, page.reviewIntervalDays],
    ["publishedAt", article.publishedAt?.toISOString() ?? null, page.publishedAt?.toISOString() ?? null],
    ["archivedAt", article.archivedAt?.toISOString() ?? null, page.archivedAt?.toISOString() ?? null],
  ];
  return checks
    .filter(([, a, p]) => a !== p)
    .map(([column, articleValue, pageValue]) => ({ column, articleValue, pageValue }));
}
