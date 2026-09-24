-- Rollback for 1175_roadmap_search_id_probe.sql.
--
-- Dropping the function is safe only once no caller executes it.
-- src/modules/build/core/projects-roadmap.service.ts calls it behind a cap+1 probe with a
-- plain-ILIKE fallback, so the roadmap search keeps returning correct rows without it --
-- it returns to the sequential scan 1175 removed. Drop the function BEFORE the indexes:
-- the indexes are only reachable from inside the function's body.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP FUNCTION IF EXISTS app.search_roadmap_item_ids(text, integer);
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_roadmap_items_description_trgm;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_roadmap_items_title_trgm;
