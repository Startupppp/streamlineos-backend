-- Rollback for migration 1125.
--
-- The forward migration created build.managed_product_memberships: a join table
-- linking org members to managed products with a role and timestamp. Dropping the
-- table removes all membership records -- product team assignments are permanently
-- lost on apply.
--
-- Indexes, the unique constraint and all three foreign keys live on this table and
-- are removed by the DROP. No enum types were introduced. No other table in this
-- migration references managed_product_memberships, so a single DROP suffices.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "build"."managed_product_memberships";
