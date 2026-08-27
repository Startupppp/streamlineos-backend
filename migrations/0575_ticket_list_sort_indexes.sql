-- OPERATOR: on a live table with existing data, run the CONCURRENTLY forms BY HAND first;
-- the IF NOT EXISTS guards below then make this migration a no-op. CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block, which is why it is not used here (backend/CLAUDE.md §3,
-- precedent 0374_build_partial_indexes.sql).
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tickets_org_project_rank_sort"
--     ON build."tickets" ("org_id", "project_id", "rank" ASC, "created_at" DESC, "id" ASC)
--     WHERE "deleted_at" IS NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tickets_org_project_created"
--     ON build."tickets" ("org_id", "project_id", "created_at" DESC, "id" ASC)
--     WHERE "deleted_at" IS NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tickets_org_project_updated"
--     ON build."tickets" ("org_id", "project_id", "updated_at" DESC, "created_at" DESC, "id" ASC)
--     WHERE "deleted_at" IS NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tickets_org_project_priority"
--     ON build."tickets" ("org_id", "project_id", "priority" ASC, "created_at" DESC, "id" ASC)
--     WHERE "deleted_at" IS NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tickets_org_project_due_date"
--     ON build."tickets" ("org_id", "project_id", "due_date" ASC, "created_at" DESC, "id" ASC)
--     WHERE "deleted_at" IS NULL;

-- Sorting the ticket list fell off every tenant-led index: measured as streamline_app with the
-- tenant GUC on a 200,002-row org, a 50-row page cost 16,725 shared blocks for four of the five
-- sortable columns, because no index carried the whole ORDER BY tuple. With count(*) OVER () in the
-- SELECT the planner must read the entire filtered set, so an uncovered sort means a heap fetch per
-- row. One index per sortable column, carrying (org_id, project_id, <sort col>, created_at, id) in
-- the query's own directions, turns all five into Index Only Scans at 180-220 blocks.
--
-- org_id leads because RLS adds org_id = app.current_org_id(), which is not leakproof: without
-- org_id in the index the planner refuses an index-only scan outright.

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "idx_tickets_org_project_rank_sort"
  ON build."tickets" ("org_id", "project_id", "rank" ASC, "created_at" DESC, "id" ASC)
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_tickets_org_project_created"
  ON build."tickets" ("org_id", "project_id", "created_at" DESC, "id" ASC)
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_tickets_org_project_updated"
  ON build."tickets" ("org_id", "project_id", "updated_at" DESC, "created_at" DESC, "id" ASC)
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_tickets_org_project_priority"
  ON build."tickets" ("org_id", "project_id", "priority" ASC, "created_at" DESC, "id" ASC)
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_tickets_org_project_due_date"
  ON build."tickets" ("org_id", "project_id", "due_date" ASC, "created_at" DESC, "id" ASC)
  WHERE "deleted_at" IS NULL;

-- An index-only scan also needs the visibility map, which a bulk-loaded table does not have.
-- OPERATOR: run this by hand after applying -- VACUUM cannot run inside a transaction block.
--   VACUUM ANALYZE build."tickets";
