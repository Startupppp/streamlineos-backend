-- Rollback for 1174_kb_articles_cutover_contract.
--
-- Recreates all EIGHT tables 1174 dropped, both enum types, every unique
-- constraint, index, foreign key, RLS policy and grant, and re-attaches the five
-- foreign keys 1174 removed from tables it kept (kb_article_chunks x2, kb_events,
-- kb_pages, support_knowledge_gaps).
--
-- WHAT THIS DOES NOT RESTORE: rows. Structure only. When 1174 was applied to
-- production on 2026-09-24 all eight tables held ZERO rows, so for that
-- application a structural restore is a complete one. That is not true in
-- general — against any database where these tables held data, restore from PITR
-- BEFORE running this, and note the window is one day.
--
-- The previous version of this file was unrunnable. It recreated one of the eight
-- tables and omitted uniq_kb_articles_org_id from the CREATE TABLE, so its next
-- statement — a foreign key referencing kb_articles (org_id, id) — failed with
-- "there is no unique constraint matching given keys for referenced table", after
-- the two enum types had already been created. check:migration-rollback did not
-- catch it because that gate checks type names and never executes anything.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TYPE "public"."kb_article_status" AS ENUM ('draft', 'in_review', 'published', 'archived');
--> statement-breakpoint

CREATE TYPE "public"."kb_article_visibility" AS ENUM ('public', 'internal');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_articles" (
  "id"                   serial PRIMARY KEY,
  "org_id"               text NOT NULL REFERENCES "public"."organizations" ("id") ON DELETE CASCADE,
  "category_id"          integer,
  "space_id"             integer,
  "title"                text NOT NULL,
  "slug"                 text NOT NULL,
  "excerpt"              text,
  "content"              text NOT NULL DEFAULT '',
  "content_text"         text NOT NULL DEFAULT '',
  "status"               "public"."kb_article_status" NOT NULL DEFAULT 'draft',
  "visibility"           "public"."kb_article_visibility" NOT NULL DEFAULT 'internal',
  "author_id"            text REFERENCES "public"."users" ("id") ON DELETE SET NULL,
  "owner_membership_id"  integer,
  "views"                integer NOT NULL DEFAULT 0,
  "helpful_count"        integer NOT NULL DEFAULT 0,
  "not_helpful_count"    integer NOT NULL DEFAULT 0,
  "fts"                  tsvector GENERATED ALWAYS AS (
                           setweight(to_tsvector('english', coalesce(title, '')), 'A')
                           || setweight(to_tsvector('english', coalesce(excerpt, '')), 'B')
                           || setweight(to_tsvector('english', coalesce(content_text, '')), 'C')
                         ) STORED,
  "seo_title"            text,
  "seo_description"      text,
  "review_interval_days" integer,
  "last_verified_at"     timestamp,
  "published_at"         timestamp,
  "archived_at"          timestamp,
  "created_at"           timestamp NOT NULL DEFAULT now(),
  "updated_at"           timestamp NOT NULL DEFAULT now(),
  "acl_revision"         integer NOT NULL DEFAULT 1,
  "content_revision"     integer NOT NULL DEFAULT 1,
  CONSTRAINT "uniq_kb_articles_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_articles_org_slug" ON "public"."kb_articles" ("org_id", "slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_articles_org_category" ON "public"."kb_articles" ("org_id", "category_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_articles_space" ON "public"."kb_articles" ("space_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_articles_org_updated" ON "public"."kb_articles" ("org_id", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_articles_org_status_views" ON "public"."kb_articles" ("org_id", "status", "views");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_articles_fts" ON "public"."kb_articles" USING gin ("fts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_articles_org_owner_actor" ON "public"."kb_articles" ("org_id", "owner_membership_id");
--> statement-breakpoint

ALTER TABLE "public"."kb_articles"
  ADD CONSTRAINT "fk_kb_articles_owner_actor"
  FOREIGN KEY ("org_id", "owner_membership_id")
  REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE SET NULL ("owner_membership_id");
--> statement-breakpoint

ALTER TABLE "public"."kb_articles"
  ADD CONSTRAINT "fk_kb_articles_org_category"
  FOREIGN KEY ("org_id", "category_id")
  REFERENCES "public"."kb_categories" ("org_id", "id")
  ON DELETE SET NULL ("category_id");
--> statement-breakpoint

ALTER TABLE "public"."kb_articles"
  ADD CONSTRAINT "fk_kb_articles_org_space"
  FOREIGN KEY ("org_id", "space_id")
  REFERENCES "public"."kb_spaces" ("org_id", "id")
  ON DELETE CASCADE;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_article_feedback" (
  "id"         serial PRIMARY KEY,
  "org_id"     text NOT NULL REFERENCES "public"."organizations" ("id") ON DELETE CASCADE,
  "article_id" integer NOT NULL,
  "helpful"    boolean NOT NULL,
  "comment"    text,
  "visitor_id" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_kb_article_feedback_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "fk_kb_article_feedback_org_article"
    FOREIGN KEY ("org_id", "article_id")
    REFERENCES "public"."kb_articles" ("org_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_article_feedback_article" ON "public"."kb_article_feedback" ("article_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_article_feedback_org_article_visitor" ON "public"."kb_article_feedback" ("org_id", "article_id", "visitor_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_article_restrictions" (
  "id"            serial PRIMARY KEY,
  "org_id"        text NOT NULL REFERENCES "public"."organizations" ("id") ON DELETE CASCADE,
  "article_id"    integer NOT NULL,
  "membership_id" integer,
  "role"          text,
  "team"          text,
  "level"         text NOT NULL DEFAULT 'view',
  "created_at"    timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_kb_article_restrictions_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "fk_kb_article_restrictions_org_article"
    FOREIGN KEY ("org_id", "article_id")
    REFERENCES "public"."kb_articles" ("org_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fk_kb_article_restrictions_org_membership"
    FOREIGN KEY ("org_id", "membership_id")
    REFERENCES "public"."organization_members" ("org_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_article_restrictions_article" ON "public"."kb_article_restrictions" ("article_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_article_restrictions_org_membership" ON "public"."kb_article_restrictions" ("org_id", "membership_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_article_restrictions_org_article" ON "public"."kb_article_restrictions" ("org_id", "article_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_article_tags" (
  "org_id"     text NOT NULL REFERENCES "public"."organizations" ("id") ON DELETE CASCADE,
  "article_id" integer NOT NULL,
  "tag_id"     integer NOT NULL,
  CONSTRAINT "kb_article_tags_org_id_article_id_tag_id_pk" PRIMARY KEY ("org_id", "article_id", "tag_id"),
  CONSTRAINT "fk_kb_article_tags_org_article"
    FOREIGN KEY ("org_id", "article_id")
    REFERENCES "public"."kb_articles" ("org_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fk_kb_article_tags_org_tag"
    FOREIGN KEY ("org_id", "tag_id")
    REFERENCES "public"."kb_tags" ("org_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_article_tags_org_tag" ON "public"."kb_article_tags" ("org_id", "tag_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_article_versions" (
  "id"                   serial PRIMARY KEY,
  "org_id"               text NOT NULL REFERENCES "public"."organizations" ("id") ON DELETE CASCADE,
  "article_id"           integer NOT NULL,
  "version_number"       integer NOT NULL,
  "title"                text NOT NULL,
  "content"              text NOT NULL DEFAULT '',
  "excerpt"              text,
  "change_summary"       text,
  "author_id"            text REFERENCES "public"."users" ("id") ON DELETE SET NULL,
  "author_membership_id" integer,
  "created_at"           timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_kb_article_versions_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "fk_kb_article_versions_org_article"
    FOREIGN KEY ("org_id", "article_id")
    REFERENCES "public"."kb_articles" ("org_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_article_versions" ON "public"."kb_article_versions" ("article_id", "version_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_article_versions_org_article" ON "public"."kb_article_versions" ("org_id", "article_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_article_translations" (
  "id"           serial PRIMARY KEY,
  "org_id"       text NOT NULL REFERENCES "public"."organizations" ("id") ON DELETE CASCADE,
  "article_id"   integer NOT NULL,
  "locale"       text NOT NULL,
  "title"        text NOT NULL,
  "content"      text NOT NULL DEFAULT '',
  "content_text" text NOT NULL DEFAULT '',
  "excerpt"      text,
  "status"       "public"."kb_translation_status" NOT NULL DEFAULT 'draft',
  "created_at"   timestamp NOT NULL DEFAULT now(),
  "updated_at"   timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_kb_article_translations_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "fk_kb_article_translations_org_article"
    FOREIGN KEY ("org_id", "article_id")
    REFERENCES "public"."kb_articles" ("org_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_article_translations" ON "public"."kb_article_translations" ("article_id", "locale");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_article_translations_org_article" ON "public"."kb_article_translations" ("org_id", "article_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_article_attachments" (
  "id"          serial PRIMARY KEY,
  "org_id"      text NOT NULL REFERENCES "public"."organizations" ("id") ON DELETE CASCADE,
  "article_id"  integer NOT NULL,
  "file_name"   text NOT NULL,
  "file_key"    text NOT NULL,
  "file_url"    text,
  "file_size"   integer,
  "mime_type"   text,
  "uploaded_by" text REFERENCES "public"."users" ("id") ON DELETE SET NULL,
  "created_at"  timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_kb_article_attachments_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "fk_kb_article_attachments_org_article"
    FOREIGN KEY ("org_id", "article_id")
    REFERENCES "public"."kb_articles" ("org_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_article_attachments_article" ON "public"."kb_article_attachments" ("article_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_article_comments" (
  "id"          serial PRIMARY KEY,
  "org_id"      text NOT NULL REFERENCES "public"."organizations" ("id") ON DELETE CASCADE,
  "article_id"  integer NOT NULL,
  "author_id"   text REFERENCES "public"."users" ("id") ON DELETE SET NULL,
  "parent_id"   integer,
  "content"     text NOT NULL,
  "resolved_at" timestamp,
  "created_at"  timestamp NOT NULL DEFAULT now(),
  "updated_at"  timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_kb_article_comments_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "fk_kb_article_comments_article_id_org"
    FOREIGN KEY ("org_id", "article_id")
    REFERENCES "public"."kb_articles" ("org_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint

ALTER TABLE "public"."kb_article_comments"
  ADD CONSTRAINT "fk_kb_article_comments_org_parent"
  FOREIGN KEY ("org_id", "parent_id")
  REFERENCES "public"."kb_article_comments" ("org_id", "id")
  ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_article_comments_article" ON "public"."kb_article_comments" ("article_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_comments_org_article" ON "public"."kb_article_comments" ("org_id", "article_id");
--> statement-breakpoint

ALTER TABLE "public"."kb_article_chunks"
  ADD CONSTRAINT "fk_kb_chunks_org_article"
  FOREIGN KEY ("org_id", "article_id")
  REFERENCES "public"."kb_articles" ("org_id", "id")
  ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "public"."kb_article_chunks"
  ADD CONSTRAINT "fk_kb_chunks_org_attachment"
  FOREIGN KEY ("org_id", "attachment_id")
  REFERENCES "public"."kb_article_attachments" ("org_id", "id")
  ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "public"."kb_events"
  ADD CONSTRAINT "fk_kb_events_org_article"
  FOREIGN KEY ("org_id", "article_id")
  REFERENCES "public"."kb_articles" ("org_id", "id")
  ON DELETE SET NULL ("article_id");
--> statement-breakpoint

ALTER TABLE "public"."kb_pages"
  ADD CONSTRAINT "fk_kb_pages_org_source_article"
  FOREIGN KEY ("org_id", "source_article_id")
  REFERENCES "public"."kb_articles" ("org_id", "id")
  ON DELETE SET NULL ("source_article_id");
--> statement-breakpoint

ALTER TABLE "public"."support_knowledge_gaps"
  ADD CONSTRAINT "fk_support_knowledge_gaps_proposed_article_id_org"
  FOREIGN KEY ("org_id", "proposed_article_id")
  REFERENCES "public"."kb_articles" ("org_id", "id")
  ON DELETE SET NULL ("proposed_article_id");
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'kb_articles', 'kb_article_feedback', 'kb_article_restrictions',
    'kb_article_tags', 'kb_article_versions', 'kb_article_translations',
    'kb_article_attachments', 'kb_article_comments'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id())',
      t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO streamline_app', t);
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  s text;
BEGIN
  FOR s IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'S'
      AND c.relname IN (
        'kb_articles_id_seq', 'kb_article_feedback_id_seq',
        'kb_article_restrictions_id_seq', 'kb_article_versions_id_seq',
        'kb_article_translations_id_seq', 'kb_article_attachments_id_seq',
        'kb_article_comments_id_seq'
      )
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO streamline_app', s);
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t, ', ')
  INTO missing
  FROM unnest(ARRAY[
    'kb_articles', 'kb_article_feedback', 'kb_article_restrictions',
    'kb_article_tags', 'kb_article_versions', 'kb_article_translations',
    'kb_article_attachments', 'kb_article_comments'
  ]) AS t
  WHERE to_regclass('public.' || t) IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation'
     )
     OR NOT has_table_privilege('streamline_app', 'public.' || t, 'SELECT');

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '1174 rollback incomplete: % lack a table, a tenant_isolation policy, or the streamline_app grant', missing;
  END IF;
END $$;
