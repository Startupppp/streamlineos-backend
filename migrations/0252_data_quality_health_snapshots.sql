-- Custom SQL migration file, put your code below! --

-- Ticket 17 / `D17`. The dataset's health becomes a number with a direction.
--
-- 0250 gave the queue a weighted composite of what is open, and `GET
-- /crm/data-quality/health` already returns it. That number on its own cannot
-- answer the question the ticket asks: a tenant sitting at 400 that was 900 last
-- month is winning, and one at 40 that was 4 is not, and a single current figure
-- reads identically in both cases.
--
-- The instinct is to skip this table and reconstruct the history from the
-- findings themselves -- `first_detected_at <= T and (resolved_at is null or
-- resolved_at > T)` looks like it yields the open set at any past instant. It is
-- wrong, and the reason is three lines of `data-quality-producers.service.ts`:
-- the filing upsert sets `severity = excluded.severity`. A finding re-banded by
-- tonight's sweep is re-banded in every reconstructed point of the last six
-- months, so the graph would move because somebody tuned a detector -- and the
-- one question this number exists to answer, did working the queue help, would
-- become unanswerable at exactly the moment anyone changed anything. A recorded
-- number is a record; a derived one is a re-derivation, and only the first can
-- be compared against itself.
--
-- A snapshot is also the only form that survives erasure. Findings carry
-- `party_id` and evidence copied out of customer records, so a subject-access
-- deletion removes them; an aggregate carries nobody. Without this table the
-- trend would improve on the day a person exercised a right, which is a number
-- lying about the thing it measures.
--
-- One row per tenant per UTC day, enforced by the unique index rather than by
-- convention. Daily because "did this week of triage help" is the question being
-- asked and an hourly series answers one nobody asks; upserted because capture
-- is invoked from every sweep and every resolution -- the moments the number
-- actually changes -- and an append-only table would then grow with traffic
-- rather than with time. It is deliberately NOT driven from `cron/`: a scheduled
-- capture credits a morning's triage to whatever else happened that day, and a
-- tenant that worked its queue and looked immediately would see nothing move.
--
-- `by_class` and `by_severity` are `jsonb` rather than a row per class. This is
-- read whole, as the shape of one day's problem, and is never aggregated across
-- classes in SQL; a row per producer would multiply the table by five to serve a
-- query nothing issues. The same reasoning `data_quality_resolutions.failures`
-- records for keeping its failures inline.
--
-- `composite` is an integer because `SEVERITY_WEIGHTS` are integers. A health
-- number with decimal places invites reading precision that is not there.
--
-- No column here is a foreign key to `users`, and not for 0223's reason -- there
-- is simply nobody to attribute. The state of a dataset is not anybody's
-- authorship. `organization_id` cascades, because a torn-down organisation's
-- graph should go with it.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_quality_health_snapshots" (
  "snapshot_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,

  -- The UTC day this point belongs to. The series' x-axis.
  "captured_on" date NOT NULL,
  -- When the day's row was last refreshed, so a stale point is visible as one.
  "captured_at" timestamp DEFAULT now() NOT NULL,

  "composite" integer NOT NULL,
  "open_total" integer NOT NULL,

  "by_class" jsonb NOT NULL,
  "by_severity" jsonb NOT NULL
);

--> statement-breakpoint
-- A penalty cannot be negative, and with every severity weighted at least 1 the
-- composite can never fall below the unweighted count. Both catch a writer that
-- has quietly stopped deriving this from the open queue.
ALTER TABLE "data_quality_health_snapshots"
  ADD CONSTRAINT "chk_data_quality_health_snapshots_counts"
  CHECK ("composite" >= 0 AND "open_total" >= 0 AND "composite" >= "open_total");

--> statement-breakpoint
ALTER TABLE "data_quality_health_snapshots"
  ADD CONSTRAINT "fk_data_quality_health_snapshots_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "data_quality_health_snapshots"
  VALIDATE CONSTRAINT "fk_data_quality_health_snapshots_org";

--> statement-breakpoint
-- The upsert target. This is what makes capture cheap enough to call from every
-- write path that changes the number, instead of from a schedule nobody owns.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_data_quality_health_snapshots_day"
  ON "data_quality_health_snapshots" ("organization_id", "captured_on");

--> statement-breakpoint
-- The series read: one tenant, ascending, bounded by a window.
CREATE INDEX IF NOT EXISTS "idx_data_quality_health_snapshots_series"
  ON "data_quality_health_snapshots" ("organization_id", "captured_on");

--> statement-breakpoint
-- The composite tenant key, so anything that later points at a snapshot has to
-- carry the organisation with it. Every new table in this programme gets one,
-- because Postgres will not accept a composite FK without a unique constraint
-- covering exactly its referenced columns and this table's key is the id alone.
ALTER TABLE "data_quality_health_snapshots"
  ADD CONSTRAINT "uniq_data_quality_health_snapshots_org_id"
  UNIQUE ("organization_id", "snapshot_id");
