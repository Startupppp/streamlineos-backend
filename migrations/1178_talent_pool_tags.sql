-- 1124 — Recruitment: tags on talent pools
--
-- Tags live on the pool rather than in a tag table. A pool carries a handful of
-- short labels that are filtered on and never joined to, and `hr_*` is frozen
-- at its current table count, so a second table would cost one of the budget
-- for no query it makes possible.
--
-- Why org_id is NOT in this index: leading a GIN index with a text column needs
-- the btree_gin extension, which this deployment does not install (see 0542).
-- The planner filters org_id through the table's existing btree and BitmapAnds
-- it with the GIN result.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "talent_pools" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_talent_pools_tags" ON "talent_pools" USING gin ("tags");
