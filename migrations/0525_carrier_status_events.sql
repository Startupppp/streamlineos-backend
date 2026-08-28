SET lock_timeout = '5s';
--> statement-breakpoint
-- INV-207. A shipment recorded a status and a shipped-at timestamp, and nothing
-- about the journey between the two. There was no way to answer "where is it"
-- or "when did the carrier say that", and no way to accept a carrier's word for
-- anything without overwriting our own.
--
-- Carrier webhooks are famously both duplicated and out of order: the same
-- event arrives three times, and OUT_FOR_DELIVERY can land after DELIVERED.
-- Both are handled here rather than hoped about --
-- `uniq_inv_shipment_status_events_carrier_event` makes replay a no-op by
-- construction rather than by a check that races, and `occurred_at` records
-- when the carrier says it happened as distinct from when we heard.
CREATE TABLE IF NOT EXISTS "inv_shipment_status_events" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "shipment_id" integer NOT NULL,
  "carrier_id" integer,
  "status" "inv_shipment_status" NOT NULL,
  -- When the carrier says it happened.
  "occurred_at" timestamp NOT NULL,
  -- When we found out. A three-hour gap between these two is the difference
  -- between a late parcel and a late webhook, and only both columns can tell
  -- them apart.
  "received_at" timestamp DEFAULT now() NOT NULL,
  "carrier_event_id" text,
  "description" text,
  -- What the carrier actually sent. Our interpretation may later be shown
  -- wrong; their payload is the record of what they claimed.
  "raw_payload" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_shipment_status_events_shipment') THEN
    ALTER TABLE "inv_shipment_status_events"
      ADD CONSTRAINT "fk_inv_shipment_status_events_shipment"
      FOREIGN KEY ("org_id", "shipment_id")
      REFERENCES "inv_shipments" ("org_id", "id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_shipment_status_events"
  VALIDATE CONSTRAINT "fk_inv_shipment_status_events_shipment";
--> statement-breakpoint
-- Partial on carrier_event_id, because a carrier that sends no event id cannot
-- be deduplicated at all and must not collide with every other such carrier on
-- a single NULL.
--
-- NULLS NOT DISTINCT is the load-bearing part. A shipment with no carrier on
-- record leaves `carrier_id` NULL, and under the default rule two NULLs never
-- conflict -- so replay protection silently did nothing for exactly the
-- shipments most likely to be hand-entered. Postgres 15 made the intended
-- behaviour expressible; before that this needed a COALESCE expression index.
DROP INDEX IF EXISTS "uniq_inv_shipment_status_events_carrier_event";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_shipment_status_events_carrier_event"
  ON "inv_shipment_status_events" ("org_id", "carrier_id", "carrier_event_id")
  NULLS NOT DISTINCT
  WHERE "carrier_event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_shipment_status_events_shipment"
  ON "inv_shipment_status_events" ("org_id", "shipment_id", "occurred_at" DESC);
