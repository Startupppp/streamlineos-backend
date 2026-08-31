-- Operator access two-person approval.
-- Adds status lifecycle (pending → active | rejected), approver identity,
-- and a data-layer CHECK that prevents self-approval.

ALTER TABLE operator_access_grants
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN approver_id TEXT;

-- Existing rows pre-date the approval workflow and are already effective grants.
-- The DEFAULT 'active' covers them without a separate UPDATE.

-- Data-layer self-approval predicate.
-- granted_by holds the requester identity.
-- NOT VALID avoids locking the table while validating the (few) existing rows;
-- VALIDATE runs immediately after and acquires only a ShareUpdateExclusiveLock.
ALTER TABLE operator_access_grants
  ADD CONSTRAINT chk_oag_self_approval
  CHECK (approver_id IS NULL OR approver_id != granted_by)
  NOT VALID;

ALTER TABLE operator_access_grants
  VALIDATE CONSTRAINT chk_oag_self_approval;

-- Lookup index for pending grants (approval queue).
CREATE INDEX idx_oag_pending
  ON operator_access_grants (org_id, created_at DESC)
  WHERE status = 'pending' AND revoked_at IS NULL;
