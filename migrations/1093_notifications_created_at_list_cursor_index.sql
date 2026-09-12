-- 1093 — serve the unified inbox's ORDER BY created_at DESC, id DESC keyset.
--
-- idx_notifications_list_cursor is (org_id, membership_id, id DESC) and still serves
-- notifications-read.service.ts:277. It cannot serve the new ordering, so the planner
-- fell back to idx_notifications_org_created (org_id, created_at) and filtered
-- membership_id per row — O(the organisation's window), not O(this member's page).
--
-- Measured on scratch_local (218,500 rows, 2 tenants, 65 memberships, 17 populated
-- partitions), as streamline_app with app.organization_id set, LIMIT 26, total buffers
-- and the notifications Append alone:
--   first page       157 -> 107  (Append  67 ->  29)   1,064 filtered ->     0
--   deep keyset page 903 -> 370  (Append 822 -> 292)  13,860 filtered ->   261
--   unreadOnly       206 -> 132  (Append 125 ->  54)   2,049 filtered ->    25
--   second tenant    127 ->  93  (Append 105 ->  15)  1,479 rows heapsorted -> 26
-- The constant ~78 buffers in every total is the actor left join on users_pkey, which
-- this index does not touch. What changes is the shape: the filtered counts were the
-- organisation's window, and are now this member's rows above the cursor.
--
-- CONCURRENTLY is unavailable twice over: PostgreSQL refuses CREATE INDEX CONCURRENTLY
-- on a partitioned parent, and drizzle-kit migrate wraps this file in one transaction.
-- Precedent 1065/1068/1079/1092 — plain CREATE INDEX under lock_timeout.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_notifications_list_created_cursor"
  ON "notifications" ("org_id", "membership_id", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL AND "archived_at" IS NULL;
--> statement-breakpoint

DO $$
DECLARE
  definition text;
  attached integer;
  partitions integer;
BEGIN
  SELECT pg_get_indexdef(x.indexrelid) INTO definition
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'idx_notifications_list_created_cursor'
     AND x.indrelid = 'notifications'::regclass;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1093: idx_notifications_list_created_cursor was not created';
  END IF;
  IF definition NOT LIKE '%org_id, membership_id, created_at DESC, id DESC%' THEN
    RAISE EXCEPTION '1093: wrong column order, the keyset is not served (%)', definition;
  END IF;
  IF definition NOT LIKE '%deleted_at IS NULL%' OR definition NOT LIKE '%archived_at IS NULL%' THEN
    RAISE EXCEPTION '1093: the partial predicate does not match the inbox read (%)', definition;
  END IF;

  SELECT count(*) INTO partitions
    FROM pg_inherits WHERE inhparent = 'notifications'::regclass;
  SELECT count(*) INTO attached
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
   WHERE i.inhparent = (SELECT oid FROM pg_class WHERE relname = 'idx_notifications_list_created_cursor');
  IF attached <> partitions THEN
    RAISE EXCEPTION '1093: % of % partitions carry the index', attached, partitions;
  END IF;
END
$$;
