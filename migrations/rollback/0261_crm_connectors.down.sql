-- Undo 0261.
--
-- Records first, then the syncs they point at: `crm_connector_records` carries
-- no foreign key to `crm_connector_syncs`, but dropping the parent first would
-- leave a table of staged records nothing can be resolved against, and the order
-- costs nothing.
--
-- Nothing here is a durable record of anything. Both tables are scratch: what a
-- connector actually landed lives in `crm_imports` and `crm_import_rows`, which
-- this does not touch, so an import stays reversible for its thirty days whether
-- or not the connector that produced it still exists.

SET lock_timeout = '5s';

--> statement-breakpoint
DROP TABLE IF EXISTS "crm_connector_records" RESTRICT;

--> statement-breakpoint
DROP TABLE IF EXISTS "crm_connector_syncs" RESTRICT;
