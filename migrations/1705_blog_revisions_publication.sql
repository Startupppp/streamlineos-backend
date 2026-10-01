-- 1705: editorial revisions, publication pointers and the tables the standalone blog admin
-- (`Startupppp/blogs`) writes to. Additive only: every legacy column stays, and after this
-- migration `blog_posts`' legacy columns hold the PUBLISHED projection of the published revision,
-- so a reader that only knows the old columns keeps serving exactly what was last published.
--
-- Publication predicate (every public read, feed, sitemap and RSS uses it):
--   status = 'published' AND published_revision_id IS NOT NULL AND published_at <= now()
--   AND archived_at IS NULL AND deleted_at IS NULL
--
-- `blog_schema_meta.version` is the contract version the admin checks before writing. It is 2
-- after this file; bump it in any migration that changes what the admin must write.
--
-- Grants: `streamline_app` (the backend) reads; `blog_editorial` is the NOLOGIN group role that
-- the admin's login role joins. It is created by the admin repo's `db/provision-editorial-role.sql`,
-- not here, so the grant to it is conditional and this file runs where the role does not exist.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.blog_posts') IS NULL OR to_regclass('public.blog_authors') IS NULL
     OR to_regclass('public.blog_categories') IS NULL THEN
    RAISE EXCEPTION '1705 precondition: blog tables are absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "blog_schema_meta" (
  "id"                     SMALLINT    PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "version"                INTEGER     NOT NULL,
  "publication_generation" BIGINT      NOT NULL DEFAULT 0,
  "updated_at"             TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

INSERT INTO "blog_schema_meta" ("id", "version") VALUES (1, 2)
ON CONFLICT ("id") DO UPDATE SET "version" = GREATEST("blog_schema_meta"."version", 2);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "blog_editors" (
  "id"          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "email"       VARCHAR(320) NOT NULL UNIQUE CHECK ("email" = lower("email")),
  "subject"     VARCHAR(255) UNIQUE,
  "name"        VARCHAR(200),
  "role"        VARCHAR(16)  NOT NULL CHECK ("role" IN ('writer', 'publisher', 'admin')),
  "author_id"   UUID         REFERENCES "blog_authors"("id") ON DELETE SET NULL,
  "disabled_at" TIMESTAMPTZ,
  "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "blog_media" (
  "id"              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "private_key"     VARCHAR(512) NOT NULL UNIQUE,
  "status"          VARCHAR(16)  NOT NULL DEFAULT 'pending'
                    CHECK ("status" IN ('pending', 'processing', 'ready', 'failed', 'deleted')),
  "file_name"       VARCHAR(255) NOT NULL,
  "declared_mime"   VARCHAR(64)  NOT NULL,
  "declared_bytes"  BIGINT       NOT NULL,
  "mime"            VARCHAR(64),
  "byte_size"       BIGINT,
  "checksum_sha256" CHAR(64),
  "width"           INTEGER,
  "height"          INTEGER,
  "variants"        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  "alt_default"     TEXT,
  "credit"          VARCHAR(300),
  "source_url"      VARCHAR(1000),
  "license"         VARCHAR(300),
  "focal_x"         REAL         NOT NULL DEFAULT 0.5 CHECK ("focal_x" BETWEEN 0 AND 1),
  "focal_y"         REAL         NOT NULL DEFAULT 0.5 CHECK ("focal_y" BETWEEN 0 AND 1),
  "failure_reason"  VARCHAR(300),
  "promoted_at"     TIMESTAMPTZ,
  "created_by"      UUID         REFERENCES "blog_editors"("id") ON DELETE SET NULL,
  "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "deleted_at"      TIMESTAMPTZ
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_media_status_created"
  ON "blog_media" ("status", "created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "blog_post_revisions" (
  "id"               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "post_id"          UUID         NOT NULL REFERENCES "blog_posts"("id") ON DELETE CASCADE,
  "seq"              INTEGER      NOT NULL,
  "schema_version"   SMALLINT     NOT NULL DEFAULT 1,
  "renderer_version" SMALLINT     NOT NULL DEFAULT 1,
  "doc"              JSONB        NOT NULL,
  "html"             TEXT         NOT NULL,
  "search_text"      TEXT         NOT NULL DEFAULT '',
  "reading_time"     INTEGER      NOT NULL DEFAULT 1 CHECK ("reading_time" >= 1),
  "title"            VARCHAR(256) NOT NULL,
  "slug"             VARCHAR(256) NOT NULL,
  "excerpt"          TEXT         NOT NULL DEFAULT '',
  "standfirst"       TEXT,
  "seo_title"        VARCHAR(256),
  "seo_description"  VARCHAR(320),
  "cover_media_id"   UUID         REFERENCES "blog_media"("id") ON DELETE RESTRICT,
  "cover_alt"        TEXT,
  "cover_caption"    TEXT,
  "social_media_id"  UUID         REFERENCES "blog_media"("id") ON DELETE RESTRICT,
  "legacy_cover_url" TEXT,
  "author_id"        UUID         REFERENCES "blog_authors"("id") ON DELETE SET NULL,
  "category_id"      UUID         REFERENCES "blog_categories"("id") ON DELETE SET NULL,
  "tags"             TEXT[]       NOT NULL DEFAULT '{}',
  "is_featured"      BOOLEAN      NOT NULL DEFAULT false,
  "cta_key"          VARCHAR(64),
  "change_summary"   VARCHAR(500),
  "frozen_at"        TIMESTAMPTZ,
  "created_by"       UUID         REFERENCES "blog_editors"("id") ON DELETE SET NULL,
  "created_at"       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "uq_blog_post_revisions_post_seq" UNIQUE ("post_id", "seq")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_post_revisions_cover_media"
  ON "blog_post_revisions" ("cover_media_id") WHERE "cover_media_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "blog_revision_media" (
  "revision_id" UUID        NOT NULL REFERENCES "blog_post_revisions"("id") ON DELETE CASCADE,
  "media_id"    UUID        NOT NULL REFERENCES "blog_media"("id") ON DELETE RESTRICT,
  "placement"   VARCHAR(16) NOT NULL CHECK ("placement" IN ('cover', 'social', 'body')),
  PRIMARY KEY ("revision_id", "media_id", "placement")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_revision_media_media"
  ON "blog_revision_media" ("media_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "blog_redirects" (
  "id"          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_path" VARCHAR(600) NOT NULL UNIQUE CHECK ("source_path" LIKE '/blogs/%'),
  "target_path" VARCHAR(600) CHECK ("target_path" LIKE '/blogs%'),
  "status_code" SMALLINT     NOT NULL DEFAULT 301 CHECK ("status_code" IN (301, 410)),
  "post_id"     UUID         REFERENCES "blog_posts"("id") ON DELETE CASCADE,
  "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "chk_blog_redirects_shape" CHECK (
    ("status_code" = 410 AND "target_path" IS NULL)
    OR ("status_code" = 301 AND "target_path" IS NOT NULL AND "target_path" <> "source_path")
  )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_redirects_target" ON "blog_redirects" ("target_path");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_redirects_post" ON "blog_redirects" ("post_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "blog_jobs" (
  "id"           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"         VARCHAR(64)  NOT NULL,
  "dedupe_key"   VARCHAR(200) UNIQUE,
  "payload"      JSONB        NOT NULL,
  "status"       VARCHAR(16)  NOT NULL DEFAULT 'pending'
                 CHECK ("status" IN ('pending', 'running', 'done', 'dead')),
  "attempts"     INTEGER      NOT NULL DEFAULT 0,
  "max_attempts" INTEGER      NOT NULL DEFAULT 8,
  "run_after"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "lease_until"  TIMESTAMPTZ,
  "last_error"   VARCHAR(1000),
  "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "completed_at" TIMESTAMPTZ
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_jobs_due"
  ON "blog_jobs" ("run_after") WHERE "status" IN ('pending', 'running');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "blog_audit_events" (
  "id"          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_id"    UUID         REFERENCES "blog_editors"("id") ON DELETE SET NULL,
  "action"      VARCHAR(64)  NOT NULL,
  "post_id"     UUID,
  "revision_id" UUID,
  "media_id"    UUID,
  "author_id"   UUID,
  "category_id" UUID,
  "editor_id"   UUID,
  "summary"     VARCHAR(500),
  "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_audit_events_post"
  ON "blog_audit_events" ("post_id", "created_at" DESC) WHERE "post_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_audit_events_created" ON "blog_audit_events" ("created_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_audit_events_actor"
  ON "blog_audit_events" ("actor_id") WHERE "actor_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_editors_author" ON "blog_editors" ("author_id") WHERE "author_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_media_created_by" ON "blog_media" ("created_by") WHERE "created_by" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_post_revisions_social_media"
  ON "blog_post_revisions" ("social_media_id") WHERE "social_media_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_post_revisions_author"
  ON "blog_post_revisions" ("author_id") WHERE "author_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_post_revisions_category"
  ON "blog_post_revisions" ("category_id") WHERE "category_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_post_revisions_created_by"
  ON "blog_post_revisions" ("created_by") WHERE "created_by" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "blog_rate_limits" (
  "bucket"       VARCHAR(200) NOT NULL,
  "window_start" TIMESTAMPTZ  NOT NULL,
  "count"        INTEGER      NOT NULL DEFAULT 0,
  PRIMARY KEY ("bucket", "window_start")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "blog_invalidation_receipts" (
  "event_id"    UUID        PRIMARY KEY,
  "post_id"     UUID,
  "generation"  BIGINT      NOT NULL,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE "blog_authors"
  ADD COLUMN IF NOT EXISTS "slug"        VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMPTZ;
--> statement-breakpoint

ALTER TABLE "blog_categories"
  ADD COLUMN IF NOT EXISTS "seo_title"       VARCHAR(256),
  ADD COLUMN IF NOT EXISTS "seo_description" VARCHAR(320),
  ADD COLUMN IF NOT EXISTS "archived_at"     TIMESTAMPTZ;
--> statement-breakpoint

ALTER TABLE "blog_posts"
  ADD COLUMN IF NOT EXISTS "working_revision_id"   UUID,
  ADD COLUMN IF NOT EXISTS "published_revision_id" UUID,
  ADD COLUMN IF NOT EXISTS "scheduled_revision_id" UUID,
  ADD COLUMN IF NOT EXISTS "scheduled_for"         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "schedule_version"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "version"               INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "modified_at"           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "archived_at"           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "deleted_at"            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "standfirst"            TEXT,
  ADD COLUMN IF NOT EXISTS "search_text"           TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "cover"                 JSONB,
  ADD COLUMN IF NOT EXISTS "social_image"          TEXT,
  ADD COLUMN IF NOT EXISTS "cta_key"               VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "owner_editor_id"       UUID;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_blog_posts_owner_editor') THEN
    ALTER TABLE "blog_posts"
      ADD CONSTRAINT "fk_blog_posts_owner_editor"
      FOREIGN KEY ("owner_editor_id") REFERENCES "blog_editors"("id") ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "blog_posts" VALIDATE CONSTRAINT "fk_blog_posts_owner_editor";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_posts_owner_editor"
  ON "blog_posts" ("owner_editor_id") WHERE "owner_editor_id" IS NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_blog_posts_working_revision') THEN
    ALTER TABLE "blog_posts"
      ADD CONSTRAINT "fk_blog_posts_working_revision"
      FOREIGN KEY ("working_revision_id") REFERENCES "blog_post_revisions"("id") ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_blog_posts_published_revision') THEN
    ALTER TABLE "blog_posts"
      ADD CONSTRAINT "fk_blog_posts_published_revision"
      FOREIGN KEY ("published_revision_id") REFERENCES "blog_post_revisions"("id") ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_blog_posts_scheduled_revision') THEN
    ALTER TABLE "blog_posts"
      ADD CONSTRAINT "fk_blog_posts_scheduled_revision"
      FOREIGN KEY ("scheduled_revision_id") REFERENCES "blog_post_revisions"("id") ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_blog_posts_schedule_pair') THEN
    ALTER TABLE "blog_posts"
      ADD CONSTRAINT "chk_blog_posts_schedule_pair"
      CHECK (("scheduled_revision_id" IS NULL) = ("scheduled_for" IS NULL)) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

-- Backfill: one frozen revision per legacy post, built from the row itself. `content_json` is kept
-- verbatim as the document; a legacy document the admin's validator rejects is converted on
-- first edit (documented in the admin repo, docs/content-migration.md), never deleted.
INSERT INTO "blog_post_revisions" (
  "post_id", "seq", "schema_version", "renderer_version", "doc", "html", "search_text",
  "reading_time", "title", "slug", "excerpt", "seo_title", "seo_description", "legacy_cover_url",
  "author_id", "category_id", "tags", "is_featured", "change_summary", "frozen_at", "created_at"
)
SELECT
  p."id", 1, 0, 0,
  COALESCE(p."content_json", jsonb_build_object('type', 'legacyHtml')),
  p."content",
  left(regexp_replace(regexp_replace(p."content", '<[^>]*>', ' ', 'g'), '\s+', ' ', 'g'), 200000),
  GREATEST(COALESCE(p."reading_time", 1), 1),
  p."title", p."slug", p."excerpt", p."meta_title", p."meta_description", p."cover_image",
  p."author_id", p."category_id", p."tags", p."is_featured",
  'Backfilled from the legacy post row by migration 1705', now(), COALESCE(p."updated_at", p."created_at")
FROM "blog_posts" p
WHERE NOT EXISTS (SELECT 1 FROM "blog_post_revisions" r WHERE r."post_id" = p."id");
--> statement-breakpoint

UPDATE "blog_posts" p SET
  "working_revision_id"   = r."id",
  "published_revision_id" = CASE WHEN p."status" = 'published' THEN r."id" END,
  "published_at"          = CASE WHEN p."status" = 'published'
                                 THEN COALESCE(p."published_at", p."created_at")
                                 ELSE p."published_at" END,
  "modified_at"           = CASE WHEN p."status" = 'published'
                                 THEN COALESCE(p."updated_at", p."published_at", p."created_at") END,
  "archived_at"           = CASE WHEN p."status" = 'archived' THEN now() END,
  "search_text"           = r."search_text"
FROM "blog_post_revisions" r
WHERE r."post_id" = p."id" AND r."seq" = 1 AND p."working_revision_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "blog_posts" VALIDATE CONSTRAINT "fk_blog_posts_working_revision";
--> statement-breakpoint

ALTER TABLE "blog_posts" VALIDATE CONSTRAINT "fk_blog_posts_published_revision";
--> statement-breakpoint

ALTER TABLE "blog_posts" VALIDATE CONSTRAINT "fk_blog_posts_scheduled_revision";
--> statement-breakpoint

ALTER TABLE "blog_posts" VALIDATE CONSTRAINT "chk_blog_posts_schedule_pair";
--> statement-breakpoint

-- Author slugs: derived from the name, de-duplicated with the row number. Two-step NOT NULL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_blog_authors_slug_not_null') THEN
    ALTER TABLE "blog_authors"
      ADD CONSTRAINT "chk_blog_authors_slug_not_null" CHECK ("slug" IS NOT NULL) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

UPDATE "blog_authors" a SET "slug" = s."slug"
FROM (
  SELECT "id",
         CASE WHEN row_number() OVER (PARTITION BY base ORDER BY "created_at", "id") = 1 THEN base
              ELSE base || '-' || row_number() OVER (PARTITION BY base ORDER BY "created_at", "id") END AS "slug"
  FROM (
    SELECT "id", "created_at",
           COALESCE(NULLIF(trim(BOTH '-' FROM regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')), ''), 'author') AS base
    FROM "blog_authors"
  ) b
) s
WHERE s."id" = a."id" AND a."slug" IS NULL;
--> statement-breakpoint

ALTER TABLE "blog_authors" VALIDATE CONSTRAINT "chk_blog_authors_slug_not_null";
--> statement-breakpoint

ALTER TABLE "blog_authors" ALTER COLUMN "slug" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "blog_authors" DROP CONSTRAINT IF EXISTS "chk_blog_authors_slug_not_null";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_blog_authors_slug" ON "blog_authors" ("slug");
--> statement-breakpoint

-- Public listing order: newest first, id breaks ties, only eligible rows.
CREATE INDEX IF NOT EXISTS "idx_blog_posts_public_order"
  ON "blog_posts" ("published_at" DESC, "id" DESC)
  WHERE "status" = 'published' AND "archived_at" IS NULL AND "deleted_at" IS NULL;
--> statement-breakpoint

-- Public search over title, excerpt and published body text. The expression is byte-identical to
-- the one BlogService emits; any divergence silently falls back to a sequential scan.
CREATE INDEX IF NOT EXISTS "idx_blog_posts_public_search"
  ON "blog_posts" USING gin (to_tsvector('english', "title" || ' ' || "excerpt" || ' ' || "search_text"));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_posts_tags" ON "blog_posts" USING gin ("tags");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_posts_scheduled"
  ON "blog_posts" ("scheduled_for") WHERE "scheduled_revision_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_posts_working_revision" ON "blog_posts" ("working_revision_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_posts_published_revision"
  ON "blog_posts" ("published_revision_id") WHERE "published_revision_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_blog_posts_scheduled_revision"
  ON "blog_posts" ("scheduled_revision_id") WHERE "scheduled_revision_id" IS NOT NULL;
--> statement-breakpoint

GRANT SELECT ON "blog_schema_meta", "blog_redirects", "blog_post_revisions" TO streamline_app;
--> statement-breakpoint

GRANT SELECT, INSERT ON "blog_invalidation_receipts" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'blog_editorial') THEN
    GRANT SELECT, INSERT, UPDATE ON
      "blog_posts", "blog_post_revisions", "blog_authors", "blog_categories", "blog_media",
      "blog_redirects", "blog_jobs", "blog_editors", "blog_rate_limits"
      TO blog_editorial;
    GRANT DELETE ON "blog_revision_media", "blog_rate_limits", "blog_redirects" TO blog_editorial;
    GRANT SELECT, INSERT ON "blog_revision_media", "blog_audit_events" TO blog_editorial;
    GRANT SELECT, UPDATE ("publication_generation", "updated_at") ON "blog_schema_meta" TO blog_editorial;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.blog_post_revisions') IS NULL OR to_regclass('public.blog_jobs') IS NULL
     OR to_regclass('public.blog_media') IS NULL OR to_regclass('public.blog_redirects') IS NULL THEN
    RAISE EXCEPTION '1705: blog editorial tables were not created';
  END IF;
  IF EXISTS (SELECT 1 FROM "blog_posts" WHERE "working_revision_id" IS NULL) THEN
    RAISE EXCEPTION '1705: a blog post was left without a working revision';
  END IF;
  IF EXISTS (SELECT 1 FROM "blog_posts" WHERE "status" = 'published' AND "published_revision_id" IS NULL) THEN
    RAISE EXCEPTION '1705: a published blog post was left without a published revision';
  END IF;
END $$;
