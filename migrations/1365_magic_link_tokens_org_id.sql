ALTER TABLE "magic_link_tokens" ADD COLUMN "org_id" text;
--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_magic_link_tokens_org" ON "magic_link_tokens" ("org_id");
