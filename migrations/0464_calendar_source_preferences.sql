SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "calendar_source_preferences" (
	"preference_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "calendar_source_preferences_preference_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_cal_src_pref_org_user_key" ON "calendar_source_preferences" USING btree ("org_id","user_id","source_key");
--> statement-breakpoint
CREATE INDEX "idx_cal_src_pref_org_user" ON "calendar_source_preferences" USING btree ("org_id","user_id");
--> statement-breakpoint
ALTER TABLE "calendar_source_preferences" ADD CONSTRAINT "calendar_source_preferences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "calendar_source_preferences" VALIDATE CONSTRAINT "calendar_source_preferences_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "calendar_source_preferences" ADD CONSTRAINT "calendar_source_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "calendar_source_preferences" VALIDATE CONSTRAINT "calendar_source_preferences_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "calendar_source_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "calendar_source_preferences";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_source_preferences"
  FOR ALL USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
