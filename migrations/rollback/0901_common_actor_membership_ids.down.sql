-- Rollback 0901: drop the membership-id columns added to common/notification/onboarding tables.
--
-- @data-loss — the backfilled membership_id pointers are discarded across all affected tables
-- (notification_deliveries, notification_preference_rules, notification_consents,
-- notification_digest_items, broadcast_read_receipts, notification_preferences,
-- push_subscriptions, onboarding_flow_sessions, user_tour_progress,
-- user_integration_connections, coupon_redemptions). This is acceptable: the legacy user-id
-- columns are still present and still populated, so all tables return to a working state.
--
-- Roll the code back first. Services that have been cut over to dual-read the membership
-- columns will fail 42703 on the next read if the columns are dropped under a running
-- deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP CONSTRAINT IF EXISTS "fk_notification_deliveries_actor";

--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "notification_preference_rules" DROP CONSTRAINT IF EXISTS "fk_notification_pref_rules_actor";

--> statement-breakpoint
ALTER TABLE "notification_preference_rules" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "notification_consents" DROP CONSTRAINT IF EXISTS "fk_notification_consents_actor";

--> statement-breakpoint
ALTER TABLE "notification_consents" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "notification_digest_items" DROP CONSTRAINT IF EXISTS "fk_notification_digest_items_actor";

--> statement-breakpoint
ALTER TABLE "notification_digest_items" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "broadcast_read_receipts" DROP CONSTRAINT IF EXISTS "fk_broadcast_read_receipts_actor";

--> statement-breakpoint
ALTER TABLE "broadcast_read_receipts" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "notification_preferences" DROP CONSTRAINT IF EXISTS "fk_notification_preferences_actor";

--> statement-breakpoint
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "push_subscriptions" DROP CONSTRAINT IF EXISTS "fk_push_subscriptions_actor";

--> statement-breakpoint
ALTER TABLE "push_subscriptions" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "onboarding_flow_sessions" DROP CONSTRAINT IF EXISTS "fk_onboarding_flow_sessions_actor";

--> statement-breakpoint
ALTER TABLE "onboarding_flow_sessions" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "user_tour_progress" DROP CONSTRAINT IF EXISTS "fk_user_tour_progress_actor";

--> statement-breakpoint
ALTER TABLE "user_tour_progress" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "user_integration_connections" DROP CONSTRAINT IF EXISTS "fk_user_integration_connections_actor";

--> statement-breakpoint
ALTER TABLE "user_integration_connections" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "coupon_redemptions" DROP CONSTRAINT IF EXISTS "fk_coupon_redemptions_actor";

--> statement-breakpoint
ALTER TABLE "coupon_redemptions" DROP COLUMN IF EXISTS "membership_id";
