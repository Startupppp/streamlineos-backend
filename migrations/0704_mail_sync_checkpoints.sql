SET lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS "mail_sync_checkpoints" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
	"account_id" integer NOT NULL,
	"folder" text NOT NULL,
	"cursor_value" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_mail_sync_checkpoint_account_folder" ON "mail_sync_checkpoints" USING btree ("account_id","folder");
--> statement-breakpoint
ALTER TABLE "mail_sync_checkpoints" ADD CONSTRAINT "uniq_mail_sync_checkpoint_org_id" UNIQUE("org_id","id");
