SET lock_timeout = '5s';
--> statement-breakpoint

DROP FUNCTION IF EXISTS app.search_roadmap_item_ids(text, integer);
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_roadmap_items_description_trgm;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_roadmap_items_title_trgm;
