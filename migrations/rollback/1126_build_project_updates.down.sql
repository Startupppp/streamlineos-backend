-- Rollback for migration 1126.
--
-- The forward migration created build.project_updates: a per-project update/post
-- table with soft-delete and a keyset cursor index. Dropping it destroys all
-- project update records permanently.
--
-- The index, the unique constraint and all three foreign keys (org_id to
-- organizations, (org_id, project_id) to build.projects with CASCADE,
-- (org_id, author_membership_id) to organization_members with RESTRICT) are
-- owned by this table and removed by the DROP. No enum types were introduced.
-- No other table created in this migration references project_updates, so a
-- single DROP is correct.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "build"."project_updates";
