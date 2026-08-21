-- 0428: PM-004 — duplicate detection / merge for feedback intake.
--
-- Feedback arrives from a public board, a widget and manual entry, so the same request is filed
-- repeatedly. With no way to merge, demand for one idea is split across several posts and every vote
-- total understates it — the board then ranks by a number that is wrong.
--
-- Per-voter dedup already existed (uniq_feedback_votes_post_voter and the IP variant), so this is not
-- about double voting. It is about duplicate POSTS.
--
-- `duplicate_of_id` is a self-reference to the canonical post; ON DELETE SET NULL so removing the
-- canonical un-merges its duplicates rather than deleting them. `merged_at` records when, and is what
-- list reads use to hide merged posts by default.
--
-- Chains are prevented in the service (merging into an already-merged post is rejected, and existing
-- duplicates are re-pointed at the new canonical), so duplicate_of_id is always exactly one hop.

ALTER TABLE "feedback_posts" ADD COLUMN IF NOT EXISTS "duplicate_of_id" integer;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "feedback_posts"
    ADD CONSTRAINT "feedback_posts_duplicate_of_id_feedback_posts_id_fk"
    FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."feedback_posts"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "feedback_posts" ADD COLUMN IF NOT EXISTS "merged_at" timestamp with time zone;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_feedback_posts_duplicate_of"
  ON "feedback_posts" ("org_id", "duplicate_of_id") WHERE duplicate_of_id IS NOT NULL;
