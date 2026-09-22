-- Rollback for migration 1090.
--
-- The forward migration created the subscription_purchases table, two indexes on it,
-- and granted SELECT/INSERT/UPDATE/DELETE on the table plus USAGE/SELECT on the
-- serial sequence to streamline_app. Dropping the table removes the indexes, the
-- owned sequence, and all privilege grants in one operation.
--
-- DATA LOSS: all rows in subscription_purchases are permanently destroyed.
-- There is no reconstruction path — purchase records represent financial intent
-- and payment state and cannot be recreated from other tables.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "subscription_purchases";
