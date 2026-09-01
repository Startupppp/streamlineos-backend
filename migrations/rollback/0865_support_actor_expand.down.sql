-- Rollback 0865: drop the support and kb_articles membership-id columns.
--
-- @data-loss — the backfilled membership-id pointers (assignee_membership_id,
-- created_by_membership_id, owner_membership_id, user_membership_id,
-- mentioned_user_membership_id) are discarded across all affected tables. This is
-- acceptable: the legacy user-id columns are still present and still populated,
-- so all tables return to a working state.
--
-- Roll the code back first. Services that have been cut over to dual-read the membership
-- columns will fail 42703 on the next read if the columns are dropped under a running
-- deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "fk_support_tickets_assignee_actor";

--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "assignee_membership_id";

--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "fk_support_tickets_created_actor";

--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "created_by_membership_id";

--> statement-breakpoint
ALTER TABLE "support_macros" DROP CONSTRAINT IF EXISTS "fk_support_macros_created_actor";

--> statement-breakpoint
ALTER TABLE "support_macros" DROP COLUMN IF EXISTS "created_by_membership_id";

--> statement-breakpoint
ALTER TABLE "support_routing_rules" DROP CONSTRAINT IF EXISTS "fk_support_routing_rules_assignee_actor";

--> statement-breakpoint
ALTER TABLE "support_routing_rules" DROP COLUMN IF EXISTS "assignee_membership_id";

--> statement-breakpoint
ALTER TABLE "support_saved_views" DROP CONSTRAINT IF EXISTS "fk_support_saved_views_owner_actor";

--> statement-breakpoint
ALTER TABLE "support_saved_views" DROP COLUMN IF EXISTS "owner_membership_id";

--> statement-breakpoint
ALTER TABLE "support_ticket_watchers" DROP CONSTRAINT IF EXISTS "fk_support_ticket_watchers_user_actor";

--> statement-breakpoint
ALTER TABLE "support_ticket_watchers" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "support_agent_skills" DROP CONSTRAINT IF EXISTS "fk_support_agent_skills_user_actor";

--> statement-breakpoint
ALTER TABLE "support_agent_skills" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "support_agent_availability" DROP CONSTRAINT IF EXISTS "fk_support_agent_availability_user_actor";

--> statement-breakpoint
ALTER TABLE "support_agent_availability" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "support_message_mentions" DROP CONSTRAINT IF EXISTS "fk_support_message_mentions_mentioned_actor";

--> statement-breakpoint
ALTER TABLE "support_message_mentions" DROP COLUMN IF EXISTS "mentioned_user_membership_id";

--> statement-breakpoint
ALTER TABLE "support_ticket_drafts" DROP CONSTRAINT IF EXISTS "fk_support_ticket_drafts_user_actor";

--> statement-breakpoint
ALTER TABLE "support_ticket_drafts" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "kb_articles" DROP CONSTRAINT IF EXISTS "fk_kb_articles_owner_actor";

--> statement-breakpoint
ALTER TABLE "kb_articles" DROP COLUMN IF EXISTS "owner_membership_id";
