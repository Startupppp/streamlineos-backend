-- 1059 DOWN — puts idx_tickets_org_project_rank_sort back in the shape 0575 gave it and
-- removes idx_tickets_org_project_rank_id.
--
-- @reopens-a-defect: this restores the index whose key columns are
-- (org_id, project_id, rank, created_at DESC, id) — created_at sitting between the two
-- columns the board's ORDER BY actually names. With it back, the board page returns to
--
--     Incremental Sort  Presorted Key: rank  Full-sort Groups: 1
--     Index Only Scan ... rows=1850
--
-- to render 101 cards on a 1,850-ticket project (18.3x), and the (rank, id) keyset cursor
-- degrades from an ordered scan that stops at the LIMIT to one that reads the project to the
-- end: 602 index rows becomes 1,850, per page, per user, five pages per board open.
--
-- Revert the `board-page-rank` check in src/scripts/check-build-read-cost.mjs in the same
-- change, or db:check-build-reads fails on its `forbidSort` assertion immediately after this
-- runs — which is the gate working, not a fault in it.
--
-- Also revert the declaration in src/db/schema/build/ticket-core.ts back to
--   index("idx_tickets_org_project_rank_sort")
--     .on(t.orgId, t.projectId, t.rank.asc(), t.createdAt.desc(), t.id.asc())
-- or the declaration and the catalog disagree, which is the 1054/1058 drift class.
--
-- No data is touched in either direction; both files only reshape indexes.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_tickets_org_project_rank_sort"
  ON build."tickets" ("org_id", "project_id", "rank" ASC, "created_at" DESC, "id" ASC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS build."idx_tickets_org_project_rank_id";
