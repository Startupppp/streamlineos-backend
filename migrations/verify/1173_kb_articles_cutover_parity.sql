-- Parity check: run after 1173_kb_articles_cutover_expand and BEFORE 1174_kb_articles_cutover_contract.
-- Inspect all result sets below.
-- GO/NO-GO: every query must return zero rows to proceed.
-- A row in any query is a blocking defect — do NOT apply 1174 until all are empty.

-- Query 1: Per-org article count vs migrated page count.
-- Expected: every row has gap = 0.
SELECT
  a.org_id,
  count(a.id)                                   AS article_count,
  count(p.id)                                   AS migrated_page_count,
  count(a.id) - count(p.id)                     AS gap
FROM "public"."kb_articles" a
LEFT JOIN "public"."kb_pages" p
  ON p.org_id = a.org_id
  AND p.source_article_id = a.id
GROUP BY a.org_id
ORDER BY gap DESC, a.org_id;

-- Query 2: Article ids with no corresponding page.
-- Expected: zero rows.
SELECT
  a.org_id,
  a.id        AS article_id,
  a.title,
  a.status
FROM "public"."kb_articles" a
WHERE NOT EXISTS (
  SELECT 1
  FROM "public"."kb_pages" p
  WHERE p.org_id = a.org_id
    AND p.source_article_id = a.id
)
ORDER BY a.org_id, a.id;

-- Query 3: Column-level mismatches — any row means the backfill is WRONG.
-- Each row identifies the org, the article, which column diverged, and both values.
-- Expected: zero rows.
SELECT
  a.org_id,
  a.id                 AS article_id,
  'slug'               AS mismatched_column,
  a.slug::text         AS article_value,
  p.slug::text         AS page_value
FROM "public"."kb_articles" a
JOIN "public"."kb_pages" p
  ON p.org_id = a.org_id AND p.source_article_id = a.id
WHERE a.slug IS DISTINCT FROM p.slug

UNION ALL

SELECT
  a.org_id, a.id, 'title',
  a.title::text, p.title::text
FROM "public"."kb_articles" a
JOIN "public"."kb_pages" p
  ON p.org_id = a.org_id AND p.source_article_id = a.id
WHERE a.title IS DISTINCT FROM p.title

UNION ALL

SELECT
  a.org_id, a.id, 'excerpt',
  a.excerpt::text, p.excerpt::text
FROM "public"."kb_articles" a
JOIN "public"."kb_pages" p
  ON p.org_id = a.org_id AND p.source_article_id = a.id
WHERE a.excerpt IS DISTINCT FROM p.excerpt

UNION ALL

SELECT
  a.org_id, a.id, 'views',
  a.views::text, p.views::text
FROM "public"."kb_articles" a
JOIN "public"."kb_pages" p
  ON p.org_id = a.org_id AND p.source_article_id = a.id
WHERE a.views IS DISTINCT FROM p.views

UNION ALL

SELECT
  a.org_id, a.id, 'helpful_count',
  a.helpful_count::text, p.helpful_count::text
FROM "public"."kb_articles" a
JOIN "public"."kb_pages" p
  ON p.org_id = a.org_id AND p.source_article_id = a.id
WHERE a.helpful_count IS DISTINCT FROM p.helpful_count

UNION ALL

SELECT
  a.org_id, a.id, 'not_helpful_count',
  a.not_helpful_count::text, p.not_helpful_count::text
FROM "public"."kb_articles" a
JOIN "public"."kb_pages" p
  ON p.org_id = a.org_id AND p.source_article_id = a.id
WHERE a.not_helpful_count IS DISTINCT FROM p.not_helpful_count

UNION ALL

SELECT
  a.org_id, a.id, 'seo_title',
  a.seo_title::text, p.seo_title::text
FROM "public"."kb_articles" a
JOIN "public"."kb_pages" p
  ON p.org_id = a.org_id AND p.source_article_id = a.id
WHERE a.seo_title IS DISTINCT FROM p.seo_title

UNION ALL

SELECT
  a.org_id, a.id, 'seo_description',
  a.seo_description::text, p.seo_description::text
FROM "public"."kb_articles" a
JOIN "public"."kb_pages" p
  ON p.org_id = a.org_id AND p.source_article_id = a.id
WHERE a.seo_description IS DISTINCT FROM p.seo_description

UNION ALL

SELECT
  a.org_id, a.id, 'review_interval_days',
  a.review_interval_days::text, p.review_interval_days::text
FROM "public"."kb_articles" a
JOIN "public"."kb_pages" p
  ON p.org_id = a.org_id AND p.source_article_id = a.id
WHERE a.review_interval_days IS DISTINCT FROM p.review_interval_days

UNION ALL

SELECT
  a.org_id, a.id, 'published_at',
  a.published_at::text, p.published_at::text
FROM "public"."kb_articles" a
JOIN "public"."kb_pages" p
  ON p.org_id = a.org_id AND p.source_article_id = a.id
WHERE a.published_at IS DISTINCT FROM p.published_at

UNION ALL

SELECT
  a.org_id, a.id, 'archived_at',
  a.archived_at::text, p.archived_at::text
FROM "public"."kb_articles" a
JOIN "public"."kb_pages" p
  ON p.org_id = a.org_id AND p.source_article_id = a.id
WHERE a.archived_at IS DISTINCT FROM p.archived_at

ORDER BY org_id, article_id, mismatched_column;
