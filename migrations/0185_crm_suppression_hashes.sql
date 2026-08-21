CREATE TABLE "crm_suppression_hashes" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"channel" "crm_consent_channel" NOT NULL,
	"address_hash" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_suppression_hashes" ADD CONSTRAINT "crm_suppression_hashes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_suppression_org_channel_hash" ON "crm_suppression_hashes" USING btree ("org_id","channel","address_hash");--> statement-breakpoint
CREATE INDEX "idx_crm_suppression_org_channel" ON "crm_suppression_hashes" USING btree ("org_id","channel");