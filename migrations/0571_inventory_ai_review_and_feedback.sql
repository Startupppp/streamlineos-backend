-- 0571 — F3/F6. The anomaly queue becomes reviewable, and an AI answer becomes
-- something a person can contradict on the record.
--
-- Two things this migration is for.
--
-- **The queue.** `inv_ai_insights` has always been a list of findings; it has
-- never been a *queue*, because a queue implies somebody works it and there was
-- nowhere to record that anybody had. Worse, the table carried no site: every
-- read was organisation-wide, so an operator assigned to one warehouse was
-- shown — and could acknowledge — findings about warehouses they cannot open.
-- §4 requires that gate to live in the SQL predicate, and a predicate needs a
-- column. `warehouse_id` is that column. It is nullable on purpose: four of the
-- six detectors aggregate a demand series across the whole organisation and
-- genuinely do not belong to one site, and a NULL is read as exactly that —
-- org-wide information, shown only to a caller whose scope is org-wide.
--
-- `window_days` and `evidence_hash` are stored beside the finding rather than
-- re-derived on read. A detector's window is part of what its claim *means*, and
-- re-deriving it from today's constants would let a threshold change next month
-- silently rewrite what last month's alert said. The hash fingerprints the
-- material figures so "is this still true?" is answerable without re-running the
-- detector — which is also what separates F6's `STALE` verdict from `WRONG`.
--
-- **The verdict.** `inv_ai_feedback` records what a person said about one AI
-- answer, keyed to the gateway call that produced it. The reason this is a table
-- and not a thumbs-up counter is that an unactionable complaint is worthless:
-- the row keeps the correlation id, the prompt key and version, the contract
-- version, the model, the evidence hash and the cost, so "the reorder brief was
-- wrong on Tuesday" resolves to one call in `ai_usage_logs` rather than to a
-- shrug. Nothing in it egresses to a provider — ids, versions and figures only,
-- plus a bounded note the reporter typed.
--
-- Locking, per §3 Migrations. Every column added to `inv_ai_insights` is
-- nullable with no default, which is a catalog-only change in PG 11+; the FKs
-- that follow would take ACCESS EXCLUSIVE on both sides for their validating
-- scan, so each is added `NOT VALID` and validated as a separate statement, and
-- `lock_timeout` makes a contended one fail fast rather than queueing every
-- write to `users` behind it. Indexes are built in the plain form because the
-- drizzle runner wraps a pending migration in one transaction and
-- `CREATE INDEX CONCURRENTLY` cannot appear inside a transaction block;
-- `inv_ai_feedback` is empty at creation and `inv_ai_insights` is a small
-- per-org finding list, so neither build is a compromise.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "inv_ai_insights" ADD COLUMN IF NOT EXISTS "warehouse_id" integer;
--> statement-breakpoint

ALTER TABLE "inv_ai_insights" ADD COLUMN IF NOT EXISTS "window_days" integer;
--> statement-breakpoint

ALTER TABLE "inv_ai_insights" ADD COLUMN IF NOT EXISTS "evidence_hash" text;
--> statement-breakpoint

ALTER TABLE "inv_ai_insights" ADD COLUMN IF NOT EXISTS "acknowledged_by" text;
--> statement-breakpoint

ALTER TABLE "inv_ai_insights" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamp;
--> statement-breakpoint

ALTER TABLE "inv_ai_insights" ADD COLUMN IF NOT EXISTS "resolution_note" text;
--> statement-breakpoint

-- F6. The four verdicts, as a type rather than as a convention. `USEFUL` and
-- `WRONG` are the obvious pair; the other two exist because they are acted on
-- differently. `STALE` says the figures were right when computed and are not
-- any more — an evidence question, not a model one. `UNSAFE` says the answer
-- invited an operator to do something they should not, and it must never be
-- averaged into a satisfaction ratio: one of those outranks a hundred `USEFUL`s.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inv_ai_feedback_verdict') THEN
    CREATE TYPE "inv_ai_feedback_verdict" AS ENUM ('USEFUL', 'WRONG', 'STALE', 'UNSAFE');
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_ai_feedback" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL,
  "surface" text NOT NULL,
  "verdict" "inv_ai_feedback_verdict" NOT NULL,
  "feature" text NOT NULL,
  "prompt_key" text NOT NULL,
  "prompt_version" integer NOT NULL,
  "contract_version" integer NOT NULL,
  "model" text NOT NULL,
  "correlation_id" text NOT NULL,
  "evidence_hash" text,
  "total_tokens" integer DEFAULT 0 NOT NULL,
  "credits" integer DEFAULT 0 NOT NULL,
  "cost_micro_usd" integer DEFAULT 0 NOT NULL,
  "note" text,
  "created_at" timestamp DEFAULT now() NOT NULL,

  CONSTRAINT "uniq_inv_ai_feedback_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

-- Guarded DO block so a re-run is a no-op rather than a duplicate-object error:
-- `ADD CONSTRAINT` has no `IF NOT EXISTS`, and a bare one below an
-- `ADD COLUMN IF NOT EXISTS` fails the whole file the second time it runs —
-- which, with a hand-applied migration, is the normal case rather than the
-- exceptional one.
--
-- Belt and braces on purpose: the catalog lookup answers the ordinary re-run,
-- and the `duplicate_object` handler answers the race where two sessions apply
-- the same file at once. Either alone leaves a way for the file to abort.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('inv_ai_insights', 'fk_inv_ai_insights_warehouse', '("warehouse_id") REFERENCES "inv_warehouses" ("id") ON DELETE CASCADE'),
      -- The composite tenant key. MATCH SIMPLE, so a NULL warehouse_id — the
      -- org-wide finding — passes the pair rather than needing an exemption.
      ('inv_ai_insights', 'fk_inv_ai_insights_warehouse_org', '("org_id", "warehouse_id") REFERENCES "inv_warehouses" ("org_id", "id")'),
      ('inv_ai_insights', 'fk_inv_ai_insights_ack_by', '("acknowledged_by") REFERENCES "users" ("id")'),
      ('inv_ai_feedback', 'fk_inv_ai_feedback_org', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      ('inv_ai_feedback', 'fk_inv_ai_feedback_user', '("user_id") REFERENCES "users" ("id")')
    ) AS t(tbl, name, spec)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = fk.name AND conrelid = fk.tbl::regclass
    ) THEN
      BEGIN
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY %s NOT VALID', fk.tbl, fk.name, fk.spec
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = fk.name AND conrelid = fk.tbl::regclass AND NOT convalidated
    ) THEN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', fk.tbl, fk.name);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- An acknowledgement with no actor is a queue nobody is accountable for, and a
-- `WRONG` or `UNSAFE` verdict with no note is a complaint nobody can act on —
-- which is the entire reason the table exists. Both are refused here rather than
-- documented as a convention.
DO $$
BEGIN
  BEGIN
    ALTER TABLE "inv_ai_insights"
      ADD CONSTRAINT "chk_inv_ai_insights_ack_pairing" CHECK (
        ("acknowledged_by" IS NULL) = ("acknowledged_at" IS NULL)
      ) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    ALTER TABLE "inv_ai_feedback"
      ADD CONSTRAINT "chk_inv_ai_feedback_note" CHECK (
        ("verdict" NOT IN ('WRONG', 'UNSAFE') OR char_length(btrim(coalesce("note", ''))) >= 10)
        AND char_length(coalesce("note", '')) <= 1000
        AND "total_tokens" >= 0
        AND "credits" >= 0
        AND "cost_micro_usd" >= 0
      ) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_ai_insights" VALIDATE CONSTRAINT "chk_inv_ai_insights_ack_pairing";
--> statement-breakpoint

ALTER TABLE "inv_ai_feedback" VALIDATE CONSTRAINT "chk_inv_ai_feedback_note";
--> statement-breakpoint

-- The queue's own read: this org, the sites I can see, open first, newest first.
-- Leads with `org_id` because RLS adds `org_id = app.current_org_id()`, which is
-- not leakproof, so an index that does not supply `org_id` itself can never
-- serve an index-only scan (§7).
CREATE INDEX IF NOT EXISTS "idx_inv_ai_insights_org_wh_status"
  ON "inv_ai_insights" ("org_id", "warehouse_id", "status", "created_at" DESC);
--> statement-breakpoint

-- One verdict per person per answer: a second submission updates the first
-- rather than stacking, so somebody who changes their mind is not two reporters.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_ai_feedback_org_user_call"
  ON "inv_ai_feedback" ("org_id", "user_id", "correlation_id");
--> statement-breakpoint

-- "How is this surface doing, and did anybody call it unsafe" — the two reads
-- the summary endpoint performs.
CREATE INDEX IF NOT EXISTS "idx_inv_ai_feedback_org_verdict"
  ON "inv_ai_feedback" ("org_id", "verdict", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_ai_feedback_org_surface"
  ON "inv_ai_feedback" ("org_id", "surface", "created_at" DESC);
--> statement-breakpoint

-- Tenant isolation, the same shape every other inventory table carries. Grants
-- to `streamline_app` arrive through `ALTER DEFAULT PRIVILEGES`, so a table left
-- without a policy is readable across every organisation and nothing says so —
-- which is why this block ships with the table rather than as a follow-up.
ALTER TABLE "inv_ai_feedback" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "inv_ai_feedback";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "inv_ai_feedback"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
