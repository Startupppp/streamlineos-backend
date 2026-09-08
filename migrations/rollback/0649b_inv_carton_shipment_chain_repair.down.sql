-- 0649b.down — Drop the carton and shipment-event tables this repair created.
--
-- @data-loss: inv_carton_types, inv_shipment_status_events
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_shipment_status_events" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_carton_types" CASCADE;
