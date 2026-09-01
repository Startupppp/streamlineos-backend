-- 0844: record which person an outbox email is for, so the retry path can re-authorise them.
--
-- The notification delivery worker already re-checks recipient authorisation immediately before
-- send, because access can be revoked between enqueue and delivery. `EmailOutboxService.
-- processRetries()` had no equivalent: an employment-sensitive email — a payslip is the concrete
-- case — enqueued before an offboarding and retried after it was delivered to someone who no
-- longer had access. The retry path could not check, because the row recorded only an address.
--
-- Nullable on purpose, and it must stay nullable. Most outbox rows are not permission-sensitive
-- (verification links, contact-form replies, anything addressed to a person who is not a member),
-- and there is no member id to record for them. `processRetries` re-authorises only rows that
-- carry a value, so NULL means "not permission-sensitive" rather than "unknown" — making the
-- column NOT NULL would force a fabricated id onto every one of those rows and turn a precise
-- signal into noise.
--
-- No backfill: rows already in the queue predate the feature and have no recorded recipient, so
-- they keep the previous behaviour rather than being guessed at. The queue drains in minutes.
--
-- No foreign key to `users`. The audit trail must survive the very deletion this column exists to
-- react to — a cascade would erase the evidence that a suppressed send was correctly suppressed,
-- and a RESTRICT would block GDPR erasure outright.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN IF NOT EXISTS "recipient_user_id" text;
