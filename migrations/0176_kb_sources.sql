CREATE TABLE IF NOT EXISTS "kb_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"space_id" integer,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"file_key" text,
	"file_url" text,
	"mime_type" text,
	"file_size" integer,
	"note_text" text,
	"status" text DEFAULT 'processing' NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_space_id_kb_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."kb_spaces"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_sources_org" ON "kb_sources" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_sources_org_space" ON "kb_sources" USING btree ("org_id","space_id");
--> statement-breakpoint
ALTER TABLE "kb_article_chunks" ADD COLUMN IF NOT EXISTS "source_id" integer;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_article_chunks" ADD CONSTRAINT "kb_article_chunks_source_id_kb_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."kb_sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_chunks_org_source" ON "kb_article_chunks" USING btree ("org_id","source_id");
