-- c21-04: finish the SCH-001 widening that stopped one table short.
--
-- SCH-001 widened `notifications.id` from int4 to bigint "while the table held 3 rows", because a
-- fan-out-on-write feed reaches 2,147,483,647 at the stated scale. The dependent key was missed:
-- `notification_audit_logs.notification_id` is still `integer`.
--
-- Postgres accepts an int4 column referencing an int8 key, so the constraint is valid and nothing
-- complains. It stays silent until the day a notification id exceeds int4, at which point every
-- audit insert fails -- on the table that exists to explain what happened.
--
-- Caught by `src/db/fk-type-consistency.spec.ts`, which now fails on any narrower-references-wider
-- foreign key in the whole schema rather than on this one instance.
--
-- Cheap by design: int4 -> int8 on a nullable column with no index rewrite. The column widens in
-- place; Postgres rewrites the table because the type width changes, so `lock_timeout` matters.
-- `notification_audit_logs` is small today -- the fan-out this anticipates has not happened yet,
-- which is precisely why now is when this is free to do.
--
-- OPERATOR: after this applies, run
--     VACUUM ANALYZE notification_audit_logs;
-- An ALTER TYPE rewrite invalidates the planner statistics AND empties the visibility map. Skipping
-- it cost one table in this codebase 53 -> 201,875 blocks on an unrelated query.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "notification_audit_logs"
  ALTER COLUMN "notification_id" TYPE bigint;
