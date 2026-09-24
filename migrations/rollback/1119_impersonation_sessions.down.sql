-- Rollback for migration 1119.
--
-- DATA LOSS: dropping impersonation_sessions destroys every impersonation audit
-- record — who impersonated whom, which sessions were revoked, start/end times,
-- and the original session ids. This is a security-relevant audit trail with no
-- recovery path once the table is gone. Confirm the records are preserved
-- elsewhere (external audit log, DB snapshot) before applying on production.
--
-- Indexes and the streamline_app SELECT/INSERT/UPDATE grant are automatically
-- removed with the table. There is no TYPE to drop (1119 creates none).

SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."impersonation_sessions";
