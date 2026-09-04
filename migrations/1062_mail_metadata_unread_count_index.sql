SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint

-- 1062 — give the unified-inbox mail badge an index to count against.
--
-- WHAT WAS WRONG. `UnifiedInboxService.countMailUnread` had no query at all. It
-- called `MailService.listMessages(..., "all", 100)` — a live Gmail/Graph fetch
-- of 100 messages per connected mailbox over HTTP — and then counted
-- `!isRead` in JavaScript. That is the badge every authenticated page renders,
-- so every page load fanned out to the providers. `mail_message_metadata`
-- already mirrors exactly the rows being counted (it is upserted on every inbox
-- load by `deferUpsertBatch`), but nothing read it for this.
--
-- Ticket 14 / PRD-C130 names "indexed … unread" explicitly. This is the index
-- half; `MailMetadataService.countUnread` is the query half.
--
-- WHY PARTIAL. Measured on the ticket-14 audit's 200k-row reproduction, as
-- `streamline_app` with the tenant GUC set and RLS on, warm, VACUUM ANALYZEd:
--
--   count(*) ... AND is_read = false, no index      Seq Scan   5,000 buffers   49.8 ms
--
-- A total index over `is_read` would carry every row of a mostly-read mailbox to
-- serve a small tail, on a table rewritten by an upsert on every inbox load. The
-- partial index carries only the rows the predicate selects.
--
-- WHY `org_id` LEADS IT. `mail_message_metadata` has RLS on (policy
-- `tenant_isolation`: `org_id = app.current_org_id()`). That qual is not
-- leakproof, so it is evaluated against the heap tuple and an index-only scan is
-- impossible unless the index supplies `org_id` itself — the planner then
-- refuses the index outright, which reads as "the index did not help"
-- (backend/CLAUDE.md section 7).
--
-- WHY `account_id` IS IN IT. `countUnread` narrows to the caller's LIVE account
-- list, because a disconnected mailbox leaves its mirrored rows behind and would
-- otherwise keep a revoked account's unread mail in the badge forever. Putting
-- the column in the index keeps that narrowing an index condition rather than a
-- heap filter.
--
-- CREATE INDEX rather than CONCURRENTLY: drizzle-kit migrate wraps the file in a
-- transaction. lock_timeout bounds the wait.

CREATE INDEX IF NOT EXISTS "idx_mail_metadata_unread_count"
  ON "mail_message_metadata" ("org_id", "user_membership_id", "folder", "account_id")
  WHERE "is_read" = false;
