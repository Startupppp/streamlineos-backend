SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "roadmap_items" ALTER COLUMN "is_public" SET DEFAULT false;
