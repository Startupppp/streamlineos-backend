ALTER TABLE build.change_requests
  DROP CONSTRAINT IF EXISTS fk_change_requests_org_release;

DROP INDEX IF EXISTS build.idx_change_requests_org_release;
DROP INDEX IF EXISTS build.idx_change_requests_org_client_visible;

ALTER TABLE build.change_requests
  DROP COLUMN IF EXISTS client_visible,
  DROP COLUMN IF EXISTS release_id;
