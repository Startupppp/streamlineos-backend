-- Migration 1149: client_visible and release_id on build.change_requests
-- Rollback: migrations/rollback/1149_change_requests_client_visible_release_id.sql

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE build.change_requests
  ADD COLUMN IF NOT EXISTS client_visible BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS release_id     INTEGER;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_change_requests_org_release
  ON build.change_requests (org_id, release_id)
  WHERE release_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_change_requests_org_client_visible
  ON build.change_requests (org_id, client_visible)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

ALTER TABLE build.change_requests
  DROP CONSTRAINT IF EXISTS fk_change_requests_org_release;
--> statement-breakpoint

ALTER TABLE build.change_requests
  ADD CONSTRAINT fk_change_requests_org_release
    FOREIGN KEY (org_id, release_id)
    REFERENCES build.project_releases (org_id, id)
    ON DELETE SET NULL (release_id)
    NOT VALID;
