SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "roadmap_votes" ADD COLUMN "voter_ip_hash" text;
--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD COLUMN "voter_ip_hash" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_roadmap_votes_item_ip" ON "roadmap_votes" ("roadmap_item_id","voter_ip_hash") WHERE voter_ip_hash IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_feedback_votes_post_ip" ON "feedback_votes" ("feedback_post_id","voter_ip_hash") WHERE voter_ip_hash IS NOT NULL;
