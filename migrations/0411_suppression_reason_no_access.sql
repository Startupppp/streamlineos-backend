-- 0410: PIPE-003 needs to record WHY a delivery was suppressed. The existing
-- notification_suppression_reason values cannot distinguish "the user muted this"
-- from "the user is no longer allowed to see it" — and an audit trail that
-- conflates a preference with an authorization decision is not an audit trail.
--
-- One statement deliberately: PostgreSQL allows ALTER TYPE ... ADD VALUE inside a
-- transaction block (Drizzle wraps each migration in one), but the new label
-- cannot be USED until that transaction commits.
--
-- Not reversible — PostgreSQL cannot drop an enum label.

ALTER TYPE "notification_suppression_reason" ADD VALUE IF NOT EXISTS 'NO_ACCESS';
