SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "fk_notification_deliveries_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_org_membership" ON "notification_deliveries" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "notification_preference_rules" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "notification_preference_rules" ADD CONSTRAINT "fk_notification_pref_rules_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_pref_rules_org_membership" ON "notification_preference_rules" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "notification_consents" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "notification_consents" ADD CONSTRAINT "fk_notification_consents_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_consents_org_membership" ON "notification_consents" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "notification_digest_items" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "notification_digest_items" ADD CONSTRAINT "fk_notification_digest_items_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_digest_items_org_membership" ON "notification_digest_items" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "broadcast_read_receipts" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "broadcast_read_receipts" ADD CONSTRAINT "fk_broadcast_read_receipts_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_read_receipts_org_membership" ON "broadcast_read_receipts" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "fk_notification_preferences_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_preferences_org_membership" ON "notification_preferences" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "fk_push_subscriptions_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_push_subs_org_membership" ON "push_subscriptions" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "onboarding_flow_sessions" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "onboarding_flow_sessions" ADD CONSTRAINT "fk_onboarding_flow_sessions_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_onb_flow_sessions_org_membership" ON "onboarding_flow_sessions" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "user_tour_progress" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "user_tour_progress" ADD CONSTRAINT "fk_user_tour_progress_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_tour_progress_org_membership" ON "user_tour_progress" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "user_integration_connections" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "user_integration_connections" ADD CONSTRAINT "fk_user_integration_connections_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_integration_connections_org_membership" ON "user_integration_connections" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "fk_coupon_redemptions_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("membership_id") NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_coupon_redemptions_org_membership" ON "coupon_redemptions" ("org_id","membership_id");
