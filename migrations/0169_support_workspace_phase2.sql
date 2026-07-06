DO $$ BEGIN
  CREATE TYPE "support_saved_view_visibility" AS ENUM ('personal', 'team', 'global');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "support_ticket_link_relation" AS ENUM ('duplicate', 'related');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "queue_id" integer;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "merged_into_ticket_id" integer;

CREATE TABLE IF NOT EXISTS "support_queues" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "filter" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_default" boolean NOT NULL DEFAULT false,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "support_queues" ADD CONSTRAINT "support_queues_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_support_queues_org_sort" ON "support_queues" ("org_id", "sort_order");

CREATE TABLE IF NOT EXISTS "support_saved_views" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "owner_id" text,
  "name" text NOT NULL,
  "filter" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "visibility" "support_saved_view_visibility" NOT NULL DEFAULT 'personal',
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "support_saved_views" ADD CONSTRAINT "support_saved_views_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "support_saved_views" ADD CONSTRAINT "support_saved_views_owner_id_users_id_fk"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_support_saved_views_org_owner" ON "support_saved_views" ("org_id", "owner_id");

CREATE TABLE IF NOT EXISTS "support_ticket_watchers" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "ticket_id" integer NOT NULL,
  "user_id" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "support_ticket_watchers" ADD CONSTRAINT "support_ticket_watchers_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "support_ticket_watchers" ADD CONSTRAINT "support_ticket_watchers_ticket_id_support_tickets_id_fk"
  FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE;

ALTER TABLE "support_ticket_watchers" ADD CONSTRAINT "support_ticket_watchers_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_support_ticket_watchers_ticket_user" ON "support_ticket_watchers" ("ticket_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_support_ticket_watchers_org_ticket" ON "support_ticket_watchers" ("org_id", "ticket_id");

CREATE TABLE IF NOT EXISTS "support_tags" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "color" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "support_tags" ADD CONSTRAINT "support_tags_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_support_tags_org_name" ON "support_tags" ("org_id", "name");

CREATE TABLE IF NOT EXISTS "support_ticket_tags" (
  "ticket_id" integer NOT NULL,
  "tag_id" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  PRIMARY KEY ("ticket_id", "tag_id")
);

ALTER TABLE "support_ticket_tags" ADD CONSTRAINT "support_ticket_tags_ticket_id_support_tickets_id_fk"
  FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE;

ALTER TABLE "support_ticket_tags" ADD CONSTRAINT "support_ticket_tags_tag_id_support_tags_id_fk"
  FOREIGN KEY ("tag_id") REFERENCES "support_tags"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_support_ticket_tags_tag" ON "support_ticket_tags" ("tag_id");

CREATE TABLE IF NOT EXISTS "support_ticket_links" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "ticket_id" integer NOT NULL,
  "linked_ticket_id" integer NOT NULL,
  "relation" "support_ticket_link_relation" NOT NULL,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "support_ticket_links" ADD CONSTRAINT "support_ticket_links_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "support_ticket_links" ADD CONSTRAINT "support_ticket_links_ticket_id_support_tickets_id_fk"
  FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE;

ALTER TABLE "support_ticket_links" ADD CONSTRAINT "support_ticket_links_linked_ticket_id_support_tickets_id_fk"
  FOREIGN KEY ("linked_ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_support_ticket_links_ticket_linked" ON "support_ticket_links" ("ticket_id", "linked_ticket_id");
CREATE INDEX IF NOT EXISTS "idx_support_ticket_links_org_ticket" ON "support_ticket_links" ("org_id", "ticket_id");

CREATE INDEX IF NOT EXISTS "idx_support_tickets_queue" ON "support_tickets" ("queue_id");
