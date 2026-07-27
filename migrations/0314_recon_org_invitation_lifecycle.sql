-- wave-1-step1-2-org-invitation-lifecycle.sql
-- Step 1: organization status enum + purge lifecycle columns (additive, nullable).
-- Step 2: invitation status enum + inviter/accepted membership + lifecycle columns + backfill.
-- Idempotent. NOT NULL contraction on status_v2 deferred (shadow phase).

DO $$ BEGIN CREATE TYPE organization_status AS ENUM ('ACTIVE','ARCHIVED','PURGE_SCHEDULED','PURGED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE invitation_status AS ENUM ('PENDING','ACCEPTED','DECLINED','EXPIRED','REVOKED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS status_v2 organization_status,
  ADD COLUMN IF NOT EXISTS purge_scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS purge_scheduled_by integer,
  ADD COLUMN IF NOT EXISTS purge_job_id text,
  ADD COLUMN IF NOT EXISTS purged_at timestamptz,
  ADD COLUMN IF NOT EXISTS purge_reason text;
CREATE INDEX IF NOT EXISTS idx_orgs_purge_scheduled ON organizations (purge_scheduled_at) WHERE status = 'PURGE_SCHEDULED';

ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS status invitation_status NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS inviter_membership_id integer,
  ADD COLUMN IF NOT EXISTS accepted_membership_id integer,
  ADD COLUMN IF NOT EXISTS declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_by integer;

UPDATE invitations SET status = CASE
  WHEN accepted_at IS NOT NULL THEN 'ACCEPTED'::invitation_status
  WHEN expires_at < now() THEN 'EXPIRED'::invitation_status
  ELSE 'PENDING'::invitation_status END
WHERE status = 'PENDING';

UPDATE invitations i SET inviter_membership_id = om.id
FROM organization_members om
WHERE om.user_id = i.invited_by AND om.org_id = i.org_id AND i.inviter_membership_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations (org_id, status);
