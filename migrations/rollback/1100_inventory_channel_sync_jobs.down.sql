-- Reverses 1100. Drops `inv_channel_jobs` and the `inv_channel_job_kind` enum.
--
-- Read this before running it: the table IS the dead-letter box. Dropping it
-- discards every record of a channel push, import or ship confirm that failed —
-- the reason, the attempt count, and which marketplace orders were already
-- imported. That last one is the part that bites: `uniq_inv_channel_job_ref` is
-- what makes a re-import a no-op, so after this rollback the next order import
-- has no memory of what it already pulled and will create a second sales order
-- for every order it sees again. Export the table before running this if any
-- import has ever succeeded.
--
-- Nothing else references it. The foreign keys point outward only —
-- `organizations`, `users`, `inv_channels`, `inv_sales_orders` — and no other
-- table points in, so a plain DROP needs no CASCADE and the absence of one is
-- the check: if this errors on a dependency, something was added after 1100 and
-- should be dropped by its own rollback first.
--
-- The enum is dropped after the table, and only if nothing else uses it. 1100 is
-- the only thing that creates it, but `DROP TYPE` refuses while any column is
-- declared with it, which is the behaviour we want rather than a CASCADE that
-- would silently drop such a column.
--
-- `inv_channel_delivery_status` is NOT dropped: it predates this migration
-- (0570) and `inv_channel_webhook_deliveries` still uses it.
--
-- Every DROP is IF EXISTS, so a re-run is a no-op.
SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_channel_jobs";
--> statement-breakpoint
DROP TYPE IF EXISTS "inv_channel_job_kind";
