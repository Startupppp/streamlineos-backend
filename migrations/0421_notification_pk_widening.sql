-- 0421: SCH-001 and SCH-018.
--
-- SCH-001  notifications / notification_deliveries / notification_queue carried
--          `serial` (int4) primary keys on the highest-fan-out tables in the product.
--          §19 requires UUID or `generatedAlwaysAsIdentity`, and int4 caps at 2.1bn —
--          reachable by a fan-out-on-write feed at the stated scale. Doing this at 3,
--          5 and 2 rows is instantaneous; at 100M rows it is an outage.
--
--          Five constraints depend on these columns, including two Wave-4 COMPOSITE
--          tenant FKs on (org_id, id) and one from notification_audit_logs. A
--          referenced column's type cannot change while an FK depends on it, so each
--          is dropped, the types widened, then re-added NOT VALID → VALIDATE (§19),
--          which keeps the ACCESS EXCLUSIVE window short. Every ON DELETE clause is
--          reproduced exactly as introspected from pg_constraint.
--
-- SCH-018  notification_audit_logs.broadcast_id was a bare integer with no FK, so a
--          deleted broadcast left an unjoinable pointer. ON DELETE SET NULL, matching
--          the notification_id constraint beside it. Verified 0 orphan rows first.
--
-- Identity is restarted above the current max so existing ids are never reissued.

SET statement_timeout = 0;
SET lock_timeout = '5s';

ALTER TABLE "notification_audit_logs"  DROP CONSTRAINT IF EXISTS "fk_notification_audit_logs_notification";
--> statement-breakpoint
-- SCH-018's constraint is added at the foot of this file, so it needs dropping here too
-- or a re-run trips "constraint already exists" before reaching the widening.
ALTER TABLE "notification_audit_logs"  DROP CONSTRAINT IF EXISTS "fk_notification_audit_logs_broadcast";
--> statement-breakpoint
ALTER TABLE "notification_queue"       DROP CONSTRAINT IF EXISTS "fk_notification_queue_delivery_id_org";
--> statement-breakpoint
ALTER TABLE "notification_queue"       DROP CONSTRAINT IF EXISTS "notification_queue_delivery_id_notification_deliveries_id_fk";
--> statement-breakpoint
ALTER TABLE "notification_deliveries"  DROP CONSTRAINT IF EXISTS "fk_notification_deliveries_notification_id_org";
--> statement-breakpoint
ALTER TABLE "notification_deliveries"  DROP CONSTRAINT IF EXISTS "notification_deliveries_notification_id_notifications_id_fk";
--> statement-breakpoint

-- serial → plain bigint: drop the default first so the owned sequence can go.
-- Guarded because the target state may already be present: an identity column has no
-- default, so an unconditional DROP DEFAULT errors ("is an identity column"), and its
-- owned sequence cannot be dropped at all while the column requires it. Both steps
-- therefore run only while the column is still a plain serial. On a cold DB that is
-- exactly the state 0000 leaves behind, so the widening path is unchanged.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications','notification_deliveries','notification_queue'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'id'
        AND is_identity = 'NO'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN id DROP DEFAULT', t);
      EXECUTE format('DROP SEQUENCE IF EXISTS %I', t || '_id_seq');
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Per column, and only when it is not already bigint. ALTER COLUMN ... TYPE rewrites the
-- whole table even when the type is unchanged, which would also blank the visibility map
-- and invalidate the planner statistics for no reason.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('notifications','id'),
      ('notification_deliveries','id'),
      ('notification_deliveries','notification_id'),
      ('notification_queue','id'),
      ('notification_queue','delivery_id'),
      ('notification_audit_logs','notification_id')
    ) AS v(tbl, col)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.col
        AND data_type <> 'bigint'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE bigint', r.tbl, r.col);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Identity, restarted above the highest existing id so nothing is reissued.
DO $$
DECLARE t text; nxt bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications','notification_deliveries','notification_queue'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'id'
        AND is_identity = 'YES'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY', t);
    END IF;
    EXECUTE format('SELECT COALESCE(MAX(id), 0) + 1 FROM %I', t) INTO nxt;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN id RESTART WITH %s', t, nxt);
  END LOOP;
END $$;
--> statement-breakpoint

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk"
  FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "fk_notification_deliveries_notification_id_org"
  FOREIGN KEY ("org_id", "notification_id") REFERENCES "notifications"("org_id", "id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "notification_queue"
  ADD CONSTRAINT "notification_queue_delivery_id_notification_deliveries_id_fk"
  FOREIGN KEY ("delivery_id") REFERENCES "notification_deliveries"("id") ON DELETE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "notification_queue"
  ADD CONSTRAINT "fk_notification_queue_delivery_id_org"
  FOREIGN KEY ("org_id", "delivery_id") REFERENCES "notification_deliveries"("org_id", "id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "notification_audit_logs"
  ADD CONSTRAINT "fk_notification_audit_logs_notification"
  FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

-- SCH-018
ALTER TABLE "notification_audit_logs"
  ADD CONSTRAINT "fk_notification_audit_logs_broadcast"
  FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE "notification_deliveries" VALIDATE CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk";
--> statement-breakpoint
ALTER TABLE "notification_deliveries" VALIDATE CONSTRAINT "fk_notification_deliveries_notification_id_org";
--> statement-breakpoint
ALTER TABLE "notification_queue"      VALIDATE CONSTRAINT "notification_queue_delivery_id_notification_deliveries_id_fk";
--> statement-breakpoint
ALTER TABLE "notification_queue"      VALIDATE CONSTRAINT "fk_notification_queue_delivery_id_org";
--> statement-breakpoint
ALTER TABLE "notification_audit_logs" VALIDATE CONSTRAINT "fk_notification_audit_logs_notification";
--> statement-breakpoint
ALTER TABLE "notification_audit_logs" VALIDATE CONSTRAINT "fk_notification_audit_logs_broadcast";
