-- 0415: two constraint defects, both free to fix at current row counts.
--
-- SCH-011  notification_preferences had a bare UNIQUE (user_id), so a user in two
--          organisations shared one preference row: org B's write overwrote org A's
--          quiet hours, digest mode and mutes. Verified 0 rows before swapping, so
--          no row can violate the new composite.
--
-- SCH-013  uq_notification_events_org_key is (org_id, event_key) with a nullable
--          org_id, and every catalog row is global (org_id IS NULL). NULL <> NULL in
--          a btree unique, so the constraint covered none of the catalog and
--          duplicate global event definitions were insertable. A partial unique
--          covers exactly the global rows.
--
-- SCH-012 (quiet_hours_timezone defaulting 'UTC' while user_preferences.timezone
-- defaults 'Asia/Kolkata') is deliberately NOT fixed here. Dropping a column in the
-- same step as the code that stops reading it is the one thing expand-contract
-- forbids. The read moves to user_preferences.timezone in this batch; the column is
-- dropped in a later contract migration once nothing reads it.

SET lock_timeout = '5s';

-- ALTER TABLE ... DROP CONSTRAINT, not DROP INDEX: this unique is owned by a table
-- constraint, so DROP INDEX fails with a dependent-object error.
ALTER TABLE "notification_preferences"
  DROP CONSTRAINT IF EXISTS "notification_preferences_user_id_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_preferences_org_user"
  ON "notification_preferences" ("org_id", "user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_events_global_key"
  ON "notification_events" ("event_key") WHERE "org_id" IS NULL;
