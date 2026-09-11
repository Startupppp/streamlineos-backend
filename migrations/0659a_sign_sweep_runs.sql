-- SIGN-P0-02. Where a sweep records that it ran.
--
-- The reminder and expiration sweeps existed with no scheduler attached to
-- them, and nothing anywhere said so. An operator looking at SignOS could not
-- tell a sweep that ran and found nothing from a sweep that had never been
-- invoked in the product's lifetime — which is exactly how it shipped unwired.
--
-- One row per (organisation, sweep): the last run, not a history. History
-- belongs in the audit log if it is ever wanted; what an admin screen needs is
-- "when did this last happen, and did it work".
--
-- `error` is nullable and is the point of the table as much as `ran_at` is. A
-- sweep that raises for one organisation must leave a mark on that
-- organisation, or the failure is invisible again.

CREATE TABLE IF NOT EXISTS "sign_sweep_runs" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "sweep" text NOT NULL,
  "ran_at" timestamp NOT NULL DEFAULT now(),
  "affected" integer NOT NULL DEFAULT 0,
  "error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_sign_sweep_runs_org_sweep" UNIQUE ("org_id", "sweep"),
  CONSTRAINT "chk_sign_sweep_runs_sweep" CHECK ("sweep" IN ('reminder', 'expiration'))
);

CREATE INDEX IF NOT EXISTS "idx_sign_sweep_runs_org" ON "sign_sweep_runs" ("org_id", "sweep");

ALTER TABLE "sign_sweep_runs" ENABLE ROW LEVEL SECURITY;

-- The RAISING accessor, deliberately. `org_id` is NOT NULL, so there is no
-- legitimate context-less read of this table; `app.current_org_id_or_null()`
-- would turn a missing tenant context into an empty result and an admin screen
-- would report "never run" for a sweep that runs nightly.
DROP POLICY IF EXISTS "tenant_isolation" ON "sign_sweep_runs";
CREATE POLICY "tenant_isolation" ON "sign_sweep_runs"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());

-- Explicit, not inherited. `has_table_privilege` answered yes before this line
-- existed, because this database happens to carry default privileges — which
-- is an environment fact, not a guarantee, and a fresh cold build need not
-- share it. 0657 grants the same way for the same reason.
REVOKE ALL ON "sign_sweep_runs" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sign_sweep_runs" TO streamline_app;
GRANT USAGE, SELECT ON SEQUENCE "sign_sweep_runs_id_seq" TO streamline_app;
