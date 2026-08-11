-- 0423: SCH-002. Every timestamp across the notification subsystem was
-- `timestamp without time zone` — 39 columns over 13 tables.
--
-- This matters more here than in most subsystems: quiet hours, digests, TTL expiry
-- and scheduled delivery all reason over these values, and a type with no offset
-- makes "22:00 local" ambiguous the moment two users or two deploys disagree about
-- what local means. It also silently survives a DST transition by being wrong.
--
-- Existing values are interpreted as UTC, stated explicitly rather than left to the
-- session TimeZone: the application writes JS Dates, which the driver sends as UTC
-- instants, so UTC is the truth those columns already hold. Doing this at 163 rows
-- across all 13 tables costs nothing; the same conversion against a populated feed
-- is a full rewrite of the largest tables in the product.
--
-- Per column and only when it is not already timestamptz. ALTER COLUMN ... TYPE
-- rewrites the whole table even when the type is unchanged, which would blank the
-- visibility map and invalidate planner statistics for no reason.

SET statement_timeout = 0;
SET lock_timeout = '5s';

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name AS tbl, c.column_name AS col
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.data_type = 'timestamp without time zone'
      AND c.table_name = ANY (ARRAY[
        'notifications','notification_deliveries','notification_queue','notification_events',
        'notification_templates','notification_preferences','notification_policy_defaults',
        'notification_provider_accounts','notification_suppression_rules','notification_audit_logs',
        'push_subscriptions','broadcasts','email_outbox'
      ])
    ORDER BY c.table_name, c.ordinal_position
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE timestamp with time zone USING %I AT TIME ZONE ''UTC''',
      r.tbl, r.col, r.col
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- A type change rewrites the table, which discards planner statistics and empties the
-- visibility map. Without this the next planner decision is made on stale stats and an
-- index-only scan silently degrades to a heap fetch.
ANALYZE "notifications";
--> statement-breakpoint
ANALYZE "notification_deliveries";
--> statement-breakpoint
ANALYZE "notification_queue";
--> statement-breakpoint
ANALYZE "notification_events";
--> statement-breakpoint
ANALYZE "email_outbox";
