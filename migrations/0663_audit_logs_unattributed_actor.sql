-- Let the audit log record an action no user took.
--
-- `audit_logs.user_id` was NOT NULL with a foreign key to `users`, so an audit
-- entry for an unattended action had nowhere to put "nobody". The convention
-- that grew around that was the literal string "system" — `systemActor()`
-- returns it as a principal id, `ActivitiesService` names it SYSTEM_AUDIT_USER,
-- and eleven call sites write `userId: x ?? "system"`. No migration or seed has
-- ever created a user with that id, and `SELECT count(*) FROM audit_logs WHERE
-- user_id = 'system'` returns zero on the live database: not one of those writes
-- has ever succeeded.
--
-- Where the write is `AuditService.log` the error is swallowed and the audit row
-- is silently lost. Where it is `logCritical` — awaited, and deliberately
-- transaction-fatal so a lost security audit cannot pass unnoticed — the 23503
-- rolls the enclosing mutation back. The public unsubscribe endpoint is the
-- reachable instance: clicking the link recorded neither the opt-out nor its
-- durable suppression hash, and mail kept going to somebody who withdrew
-- consent.
--
-- NULL rather than a synthetic `users` row. `users` is the authentication
-- identity table, and a row in it is a principal: it would resolve in profile
-- lookups, match the audit log's `userSearch` ilike over name and email, be
-- emitted by the audit CSV export as though a person had acted, and appear in
-- the personal-data surface as a data subject who does not exist. Every
-- audit_logs reader already `LEFT JOIN`s `users` — they were written to tolerate
-- an actor that does not resolve — so a null costs them nothing and reads
-- truthfully, while a sentinel row would make the platform look like a person.
--
-- The CHECK is the half that keeps the loudness the foreign key was accidentally
-- providing. A bare nullable column makes "no user acted" indistinguishable from
-- "a user acted and we lost the id", and the second is a silent audit defect. So
-- an unattributed row must name the system that acted, in the same shape the
-- deal stage ledger and the activity timeline already use for this question: the
-- system case is a real case that names itself, not an absence. `AuditService`
-- enforces the same rule in its types; this is the backstop for anything that
-- reaches the table another way.
--
-- Cost on a hot append-heavy table: `DROP NOT NULL` is catalog-only, no rewrite.
-- The CHECK is added NOT VALID and validated in a separate statement, so the
-- scan is its own interruptible step rather than part of the ADD. It cannot
-- fail: one statement earlier every row in the table still had a NOT NULL
-- `user_id`, so all of them satisfy the constraint by construction. (This
-- runner commits the whole file in one transaction, so the split does not
-- itself lower the lock class held over the file — it keeps the scan separable
-- and leaves a fully validated constraint behind rather than a permanent
-- NOT VALID one.)
SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE audit_logs
  ALTER COLUMN user_id DROP NOT NULL;

--> statement-breakpoint
ALTER TABLE audit_logs
  ADD CONSTRAINT chk_audit_logs_actor_attributed
  CHECK (
    user_id IS NOT NULL
    OR (metadata IS NOT NULL AND jsonb_exists(metadata, 'systemActor'))
  ) NOT VALID;

--> statement-breakpoint
ALTER TABLE audit_logs
  VALIDATE CONSTRAINT chk_audit_logs_actor_attributed;

--> statement-breakpoint
COMMENT ON COLUMN audit_logs.user_id IS
  'The user who acted, or NULL when no user did. NULL requires metadata.systemActor naming the unattended path that acted (chk_audit_logs_actor_attributed) — never write a sentinel id such as ''system'', which has no row in users.';
