-- The one tenant table of 744 whose RLS qual could not be answered from an
-- index. `check:tenant-indexes` has been failing on it.
--
-- `subprocessor_subscribers` carries RLS with
-- `tenant_isolation: (organization_id = current_org_id())`, so EVERY read of it
-- carries that predicate. Its two indexes lead with `email` and
-- `unsubscribed_at`, so neither can serve the policy and the planner is left
-- with a sequential scan — and per backend CLAUDE.md section 7 an index on an
-- RLS table must contain `org_id` for the planner to consider it at all, since
-- the policy qual is not leakproof and is evaluated against the heap tuple.
--
-- The table is empty today, which is why this has cost nothing yet and is
-- exactly when it is cheap to fix.
--
-- Partial on the live rows: every read of this list is "who should be notified",
-- and an unsubscribed row is never in that answer. It also keeps the index off
-- the tombstones the table deliberately retains — the column comment says the
-- row stays after unsubscribing so a re-subscribe is one act.
--
-- Hand-authored, per 0464: `migrations/meta` snapshots stop at 0231, so
-- `drizzle-kit generate` is unusable in this repository.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subprocessor_subscribers_org_active"
  ON "public"."subprocessor_subscribers" ("organization_id", "email")
  WHERE "unsubscribed_at" IS NULL;
