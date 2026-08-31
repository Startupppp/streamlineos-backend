-- Version snapshots tracked author by `users.id` only. Adding `author_membership_id` lets
-- the version history surface the membership-scoped identity (who in this org made the edit),
-- which survives user deactivation and is consistent with the actor columns added to
-- kb_page_favorites / kb_page_visits / kb_page_reviews in migrations 0661/0662.
-- Nullable: existing rows have no membership id and must not fail on apply.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "kb_page_versions" ADD COLUMN IF NOT EXISTS "author_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD COLUMN IF NOT EXISTS "author_membership_id" integer;
