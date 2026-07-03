CREATE TABLE IF NOT EXISTS "kb_pages" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "space_id" integer,
  "parent_page_id" integer,
  "title" text NOT NULL DEFAULT '',
  "icon" text,
  "cover_image" text,
  "content" jsonb,
  "content_text" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_locked" boolean NOT NULL DEFAULT false,
  "created_by_id" text,
  "last_edited_by_id" text,
  "deleted_at" timestamp with time zone,
  "deleted_by_id" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_page_favorites" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "page_id" integer NOT NULL,
  "user_id" text NOT NULL,
  "sort_order" integer DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_page_visits" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "page_id" integer NOT NULL,
  "user_id" text NOT NULL,
  "visited_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_page_links" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "source_page_id" integer NOT NULL,
  "target_page_id" integer NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_page_versions" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "page_id" integer NOT NULL,
  "version_number" integer NOT NULL,
  "title" text NOT NULL DEFAULT '',
  "content" jsonb,
  "author_id" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_page_comments" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "page_id" integer NOT NULL,
  "author_id" text,
  "parent_id" integer,
  "content" text NOT NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_page_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "icon" text,
  "description" text,
  "content" jsonb,
  "created_by_id" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "kb_pages"
  ADD CONSTRAINT "kb_pages_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_pages"
  ADD CONSTRAINT "kb_pages_space_id_kb_spaces_id_fk"
  FOREIGN KEY ("space_id") REFERENCES "kb_spaces"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_pages"
  ADD CONSTRAINT "kb_pages_created_by_id_users_id_fk"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_pages"
  ADD CONSTRAINT "kb_pages_last_edited_by_id_users_id_fk"
  FOREIGN KEY ("last_edited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_favorites"
  ADD CONSTRAINT "kb_page_favorites_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_favorites"
  ADD CONSTRAINT "kb_page_favorites_page_id_kb_pages_id_fk"
  FOREIGN KEY ("page_id") REFERENCES "kb_pages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_favorites"
  ADD CONSTRAINT "kb_page_favorites_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_visits"
  ADD CONSTRAINT "kb_page_visits_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_visits"
  ADD CONSTRAINT "kb_page_visits_page_id_kb_pages_id_fk"
  FOREIGN KEY ("page_id") REFERENCES "kb_pages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_visits"
  ADD CONSTRAINT "kb_page_visits_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_links"
  ADD CONSTRAINT "kb_page_links_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_links"
  ADD CONSTRAINT "kb_page_links_source_page_id_kb_pages_id_fk"
  FOREIGN KEY ("source_page_id") REFERENCES "kb_pages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_links"
  ADD CONSTRAINT "kb_page_links_target_page_id_kb_pages_id_fk"
  FOREIGN KEY ("target_page_id") REFERENCES "kb_pages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_versions"
  ADD CONSTRAINT "kb_page_versions_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_versions"
  ADD CONSTRAINT "kb_page_versions_page_id_kb_pages_id_fk"
  FOREIGN KEY ("page_id") REFERENCES "kb_pages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_versions"
  ADD CONSTRAINT "kb_page_versions_author_id_users_id_fk"
  FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_comments"
  ADD CONSTRAINT "kb_page_comments_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_comments"
  ADD CONSTRAINT "kb_page_comments_page_id_kb_pages_id_fk"
  FOREIGN KEY ("page_id") REFERENCES "kb_pages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_comments"
  ADD CONSTRAINT "kb_page_comments_author_id_users_id_fk"
  FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_templates"
  ADD CONSTRAINT "kb_page_templates_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_templates"
  ADD CONSTRAINT "kb_page_templates_created_by_id_users_id_fk"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_parent_sort" ON "kb_pages" ("org_id", "parent_page_id", "sort_order");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_deleted" ON "kb_pages" ("org_id", "deleted_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_updated" ON "kb_pages" ("org_id", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_pages_parent" ON "kb_pages" ("parent_page_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_page_favorites_page_user" ON "kb_page_favorites" ("page_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_page_favorites_org_user" ON "kb_page_favorites" ("org_id", "user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_page_visits_page_user" ON "kb_page_visits" ("page_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_page_visits_org_user_visited" ON "kb_page_visits" ("org_id", "user_id", "visited_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_page_links_source_target" ON "kb_page_links" ("source_page_id", "target_page_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_page_links_org_target" ON "kb_page_links" ("org_id", "target_page_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_page_versions_page_version" ON "kb_page_versions" ("page_id", "version_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_page_comments_org_page" ON "kb_page_comments" ("org_id", "page_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_page_templates_org" ON "kb_page_templates" ("org_id");
