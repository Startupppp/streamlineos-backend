-- 0586.down — Remove kit component definitions.
--
-- @data-loss: inv_kit_components
SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_kit_components" CASCADE;
