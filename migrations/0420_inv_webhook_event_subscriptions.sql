-- 0420: Webhook event subscriptions become a table (SCH-006, first slice).
--
-- inv_webhooks.events is a jsonb string[]. It cannot be indexed for the query
-- that matters, so webhook-emitter.service.ts loads EVERY active webhook for the
-- org and filters in application memory:
--     webhooks.filter((w) => (w.events as string[]).includes(eventType))
-- With a table that becomes an indexed predicate.
--
-- EXPAND step only: the jsonb column is retained and still written, so this is
-- reversible. The contract step (dropping inv_webhooks.events) is separate.

SET statement_timeout = 0;
SET lock_timeout = '5s';

CREATE TABLE "inv_webhook_event_subscriptions" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "webhook_id" integer NOT NULL,
  "event_type" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_webhook_event_subs_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "fk_inv_webhook_event_subs_org"
    FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_inv_webhook_event_subs_org_webhook"
    FOREIGN KEY ("org_id", "webhook_id") REFERENCES "inv_webhooks" ("org_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_inv_webhook_event_subs_key"
  ON "inv_webhook_event_subscriptions" ("org_id", "webhook_id", "event_type");
--> statement-breakpoint

-- The dispatch predicate: given an org and an event type, which webhooks fire.
CREATE INDEX "idx_inv_webhook_event_subs_dispatch"
  ON "inv_webhook_event_subscriptions" ("org_id", "event_type");
--> statement-breakpoint

-- Backfill from the retained jsonb column.
INSERT INTO "inv_webhook_event_subscriptions" ("org_id", "webhook_id", "event_type")
SELECT w."org_id", w."id", e.value::text
FROM "inv_webhooks" w
CROSS JOIN LATERAL jsonb_array_elements_text(w."events") AS e(value)
ON CONFLICT DO NOTHING;
