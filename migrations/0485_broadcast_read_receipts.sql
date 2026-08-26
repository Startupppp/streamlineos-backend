-- 0485: broadcast read receipts — c21-02, fan-out on READ.
--
-- Publishing a broadcast used to insert one notification row per recipient, in
-- sequential batches of 100, inside a single transaction. A 50,000-member
-- announcement held one connection for minutes and exceeded the HTTP timeout.
--
-- Unread state for a broadcast is now the ABSENCE of a row here, so publish
-- writes nothing per recipient and is O(1) whatever the audience size. A row
-- appears only when someone dismisses.
--
-- WITHOUT THIS MIGRATION the broadcast inbox and dismiss endpoints raise
-- "relation broadcast_read_receipts does not exist", and because publish no
-- longer writes notification rows, broadcasts would publish successfully and
-- be visible to nobody. The service change and this migration ship together.
--
-- Every index leads with org_id. Under RLS the policy qual is not leakproof,
-- so the planner cannot use an index that omits the tenant column — a covering
-- index without it exists and is silently ignored.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "broadcast_read_receipts" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "broadcast_id" integer NOT NULL REFERENCES "broadcasts"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "dismissed_at" timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
-- The uniqueness constraint is the real idempotency guarantee: repeat
-- dismissal is an onConflictDoNothing, not an application-level check that
-- loses under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_broadcast_read_receipts_org_user_broadcast"
  ON "broadcast_read_receipts" ("org_id", "broadcast_id", "user_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_read_receipts_admin"
  ON "broadcast_read_receipts" ("org_id", "broadcast_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_read_receipts_user"
  ON "broadcast_read_receipts" ("org_id", "user_id");

--> statement-breakpoint
ALTER TABLE "broadcast_read_receipts" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
-- A table with no policy is readable org-wide, because grants arrive via
-- ALTER DEFAULT PRIVILEGES. The tenant GUC is the boundary.
CREATE POLICY "broadcast_read_receipts_tenant_isolation"
  ON "broadcast_read_receipts"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
