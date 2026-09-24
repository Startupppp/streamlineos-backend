-- THIS ROLLBACK CANNOT RESTORE DATA.
--
-- Migration 1174 dropped the following tables and their data:
--   kb_articles
--   kb_article_feedback
--   kb_article_restrictions
--   kb_article_tags
--   kb_article_versions
--   kb_article_translations
--   kb_article_attachments
--   kb_article_comments
--
-- It also dropped the enum types kb_article_status and kb_article_visibility,
-- and removed FK constraints from kb_article_chunks, kb_events, kb_pages and
-- support_knowledge_gaps.
--
-- To recover article data, restore from PITR (point-in-time recovery) to a
-- snapshot taken before 1174 was applied.
--
-- The statements below recreate only the table STRUCTURES and re-attach the FK
-- constraints so subsequent schema migrations can be applied. They insert no
-- data. Before running them, restore from PITR.

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
  "seo_title"            text,
  "seo_description"      text,
  "review_interval_days" integer,
  "last_verified_at"     timestamp,
  "published_at"         timestamp,
  "archived_at"          timestamp,
  "created_at"           timestamp NOT NULL DEFAULT now(),
  "updated_at"           timestamp NOT NULL DEFAULT now(),
  "acl_revision"         integer NOT NULL DEFAULT 1,
  "content_revision"     integer NOT NULL DEFAULT 1
);
--> statement-breakpoint

-- Restore inbound FKs on tables that kept their columns.
ALTER TABLE "public"."kb_events"
  ADD CONSTRAINT "fk_kb_events_org_article"
  FOREIGN KEY ("org_id", "article_id")
  REFERENCES "public"."kb_articles" ("org_id", "id")
  ON DELETE SET NULL (article_id);
--> statement-breakpoint

ALTER TABLE "public"."kb_pages"
  ADD CONSTRAINT "fk_kb_pages_org_source_article"
  FOREIGN KEY ("org_id", "source_article_id")
  REFERENCES "public"."kb_articles" ("org_id", "id")
  ON DELETE SET NULL (source_article_id);
--> statement-breakpoint

ALTER TABLE "public"."support_knowledge_gaps"
  ADD CONSTRAINT "fk_support_knowledge_gaps_proposed_article_id_org"
  FOREIGN KEY ("org_id", "proposed_article_id")
  REFERENCES "public"."kb_articles" ("org_id", "id")
  ON DELETE SET NULL (proposed_article_id);
