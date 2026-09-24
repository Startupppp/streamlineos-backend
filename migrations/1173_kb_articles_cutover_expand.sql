SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_articles') IS NULL THEN
    RAISE EXCEPTION '1173 precondition: public.kb_articles is absent';
  END IF;
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1173 precondition: public.kb_pages is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'kb_pages'
      AND a.attname = 'source_article_id' AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION '1173 precondition: kb_pages.source_article_id column is absent — apply earlier migrations first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'kb_articles'
      AND a.attname = 'content_text' AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION '1173 precondition: kb_articles.content_text column is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'kb_pages'
      AND a.attname = 'slug' AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION '1173 precondition: kb_pages.slug column is absent — apply 1172a first';
  END IF;
END $$;
--> statement-breakpoint

INSERT INTO "public"."kb_pages" (
  "org_id",
  "title",
  "content",
  "content_text",
  "space_id",
  "status",
  "owner_membership_id",
  "created_by_id",
  "source_article_id",
  "visibility",
  "trust_state",
  "content_type",
  "sort_order",
  "acl_revision",
  "content_revision",
  "slug",
  "excerpt",
  "category_id",
  "views",
  "helpful_count",
  "not_helpful_count",
  "seo_title",
  "seo_description",
  "review_interval_days",
  "published_at",
  "archived_at"
)
SELECT
  a.org_id,
  a.title,
  jsonb_build_object(
    'type', 'doc',
    'content', CASE
      WHEN trim(coalesce(a.content_text, '')) = '' THEN
        jsonb_build_array(
          jsonb_build_object(
            'type', 'p',
            'children', jsonb_build_array(jsonb_build_object('text', ''))
          )
        )
      ELSE
        coalesce(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'type', 'p',
                'children', jsonb_build_array(jsonb_build_object('text', trimmed))
              )
            )
            FROM (
              SELECT trim(para) AS trimmed
              FROM unnest(regexp_split_to_array(a.content_text, '\n{2,}')) AS para
              WHERE trim(para) <> ''
              LIMIT 500
            ) paras
          ),
          jsonb_build_array(
            jsonb_build_object(
              'type', 'p',
              'children', jsonb_build_array(jsonb_build_object('text', ''))
            )
          )
        )
    END
  ) AS content,
  NULLIF(trim(a.content_text), '') AS content_text,
  a.space_id,
  a.status::text AS status,
  a.owner_membership_id,
  a.author_id AS created_by_id,
  a.id AS source_article_id,
  CASE a.visibility
    WHEN 'public' THEN 'public'
    ELSE 'org'
  END AS visibility,
  CASE
    WHEN a.last_verified_at IS NOT NULL
      AND a.last_verified_at >= now() - INTERVAL '180 days'
    THEN 'verified'
    ELSE 'unverified'
  END AS trust_state,
  'support_article' AS content_type,
  a.id * 100 AS sort_order,
  a.acl_revision,
  a.content_revision,
  a.slug,
  a.excerpt,
  a.category_id,
  a.views,
  a.helpful_count,
  a.not_helpful_count,
  a.seo_title,
  a.seo_description,
  a.review_interval_days,
  a.published_at,
  a.archived_at
FROM "public"."kb_articles" a
WHERE NOT EXISTS (
  SELECT 1 FROM "public"."kb_pages" p
  WHERE p.org_id = a.org_id
    AND p.source_article_id = a.id
);
