SET lock_timeout = '5s';

-- No FK to organizations, deliberately. A pending-purge row records a blob that still
-- needs deleting; a cascade would erase that record exactly when the org is purged,
-- recreating the orphan this table exists to prevent. org_id is the tenant key only.

CREATE TABLE "storage_pending_purge" (
  "id"                uuid         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "org_id"            text         NOT NULL,
  "storage_key"       text         NOT NULL,
  "purpose"           text         NOT NULL,
  "status"            text         NOT NULL DEFAULT 'pending'
    CONSTRAINT "storage_pending_purge_status_check"
      CHECK ("status" IN ('pending', 'confirmed', 'failed')),
  "attempt_count"     integer      NOT NULL DEFAULT 0,
  "created_at"        timestamptz  NOT NULL DEFAULT now(),
  "confirmed_at"      timestamptz,
  "last_attempted_at" timestamptz,
  "failed_reason"     text
);

CREATE UNIQUE INDEX "uniq_storage_pending_purge_org_key"
  ON "storage_pending_purge" ("org_id", "storage_key");

CREATE INDEX "idx_storage_pending_purge_retry"
  ON "storage_pending_purge" ("org_id", "status", "created_at")
  WHERE "status" IN ('pending', 'failed');

ALTER TABLE "storage_pending_purge" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.storage_pending_purge
  FOR ALL
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
