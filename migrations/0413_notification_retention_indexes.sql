-- 0413: SEC-009. Indexes for the retention sweep. Without them the 90-day body
-- purge and the 13-month row delete both seq-scan the two largest append-only
-- tables in the product, every run.
--
-- The email_outbox index is PARTIAL on `html <> ''`: after the first sweep most
-- rows have an empty body, so the partial index stays small and the purge only
-- ever scans rows that still hold content.
--
-- The notification_deliveries index leads with org_id because that sweep runs
-- per tenant via forEachOrg — the table enforces org_id = app.current_org_id(),
-- so a global sweep is denied 42501 (CLAUDE.md §19, §20).

SET statement_timeout = 0;
SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "idx_email_outbox_body_retention"
  ON "email_outbox" ("created_at") WHERE "html" <> '';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_email_outbox_created_at"
  ON "email_outbox" ("created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_retention"
  ON "notification_deliveries" ("org_id", "created_at");
