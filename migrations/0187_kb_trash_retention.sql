CREATE TABLE IF NOT EXISTS "kb_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"trash_retention_days" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_settings" ADD CONSTRAINT "kb_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_settings_org" ON "kb_settings" USING btree ("org_id");
