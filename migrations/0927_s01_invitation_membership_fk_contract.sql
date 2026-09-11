-- @irreversible
-- 0927: S01 invitation membership FKs are tenant-composite.
-- Invalid historical attribution is reported and cleared because no safe
-- membership can be inferred from an orphan or cross-tenant scalar id.

SET lock_timeout = '5s';

CREATE TEMP TABLE _s01_invitation_fk_report (
  invitation_id text NOT NULL,
  org_id text NOT NULL,
  column_name text NOT NULL,
  membership_id integer NOT NULL,
  reason text NOT NULL
) ON COMMIT DROP;

INSERT INTO _s01_invitation_fk_report (invitation_id, org_id, column_name, membership_id, reason)
SELECT i.id, i.org_id, 'inviter_membership_id', i.inviter_membership_id, 'orphan'
FROM invitations i WHERE i.inviter_membership_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.id = i.inviter_membership_id)
UNION ALL SELECT i.id, i.org_id, 'accepted_membership_id', i.accepted_membership_id, 'orphan'
FROM invitations i WHERE i.accepted_membership_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.id = i.accepted_membership_id)
UNION ALL SELECT i.id, i.org_id, 'revoked_by_membership_id', i.revoked_by_membership_id, 'orphan'
FROM invitations i WHERE i.revoked_by_membership_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.id = i.revoked_by_membership_id);
--> statement-breakpoint

INSERT INTO _s01_invitation_fk_report (invitation_id, org_id, column_name, membership_id, reason)
SELECT i.id, i.org_id, 'inviter_membership_id', i.inviter_membership_id, 'cross_tenant'
FROM invitations i JOIN organization_members m ON m.id = i.inviter_membership_id
WHERE i.inviter_membership_id IS NOT NULL AND m.org_id <> i.org_id
UNION ALL SELECT i.id, i.org_id, 'accepted_membership_id', i.accepted_membership_id, 'cross_tenant'
FROM invitations i JOIN organization_members m ON m.id = i.accepted_membership_id
WHERE i.accepted_membership_id IS NOT NULL AND m.org_id <> i.org_id
UNION ALL SELECT i.id, i.org_id, 'revoked_by_membership_id', i.revoked_by_membership_id, 'cross_tenant'
FROM invitations i JOIN organization_members m ON m.id = i.revoked_by_membership_id
WHERE i.revoked_by_membership_id IS NOT NULL AND m.org_id <> i.org_id;
--> statement-breakpoint

DO $$
DECLARE duplicate_count bigint;
DECLARE invalid_count bigint;
BEGIN
  SELECT count(*) INTO duplicate_count FROM (
    SELECT org_id, id FROM organization_members GROUP BY org_id, id HAVING count(*) > 1
  ) duplicate_memberships;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION '0927 blocked: % duplicate organization_members (org_id, id) mappings', duplicate_count;
  END IF;
  SELECT count(*) INTO invalid_count FROM _s01_invitation_fk_report;
  IF invalid_count > 0 THEN
    RAISE NOTICE '0927 invitation FK report: % orphan/cross-tenant attribution row(s) will be nulled', invalid_count;
  END IF;
END $$;
--> statement-breakpoint

UPDATE invitations i SET inviter_membership_id = NULL
WHERE i.inviter_membership_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM organization_members m WHERE m.org_id = i.org_id AND m.id = i.inviter_membership_id
);
--> statement-breakpoint
UPDATE invitations i SET accepted_membership_id = NULL
WHERE i.accepted_membership_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM organization_members m WHERE m.org_id = i.org_id AND m.id = i.accepted_membership_id
);
--> statement-breakpoint
UPDATE invitations i SET revoked_by_membership_id = NULL
WHERE i.revoked_by_membership_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM organization_members m WHERE m.org_id = i.org_id AND m.id = i.revoked_by_membership_id
);
--> statement-breakpoint

DO $$
DECLARE target record;
DECLARE constraint_name text;
BEGIN
  FOR target IN SELECT * FROM (VALUES ('inviter_membership_id'), ('accepted_membership_id'), ('revoked_by_membership_id')) AS requested(column_name) LOOP
    FOR constraint_name IN
      SELECT c.conname FROM pg_constraint c
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = c.confrelid
      JOIN pg_namespace parent_schema ON parent_schema.oid = parent.relnamespace
      JOIN LATERAL unnest(c.conkey) child_key(attnum) ON true
      JOIN pg_attribute child_attribute ON child_attribute.attrelid = child.oid AND child_attribute.attnum = child_key.attnum
      JOIN LATERAL unnest(c.confkey) parent_key(attnum) ON true
      JOIN pg_attribute parent_attribute ON parent_attribute.attrelid = parent.oid AND parent_attribute.attnum = parent_key.attnum
      WHERE c.contype = 'f' AND child_schema.nspname = 'public' AND child.relname = 'invitations'
        AND child_attribute.attname = target.column_name AND array_length(c.conkey, 1) = 1
        AND parent_schema.nspname = 'public' AND parent.relname = 'organization_members' AND parent_attribute.attname = 'id'
    LOOP
      EXECUTE format('ALTER TABLE invitations DROP CONSTRAINT %I', constraint_name);
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_invitations_org_inviter_membership ON invitations (org_id, inviter_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_invitations_org_accepted_membership ON invitations (org_id, accepted_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_invitations_org_revoked_by_membership ON invitations (org_id, revoked_by_membership_id);
--> statement-breakpoint

ALTER TABLE invitations ADD CONSTRAINT fk_invitations_org_inviter_membership
  FOREIGN KEY (org_id, inviter_membership_id) REFERENCES organization_members (org_id, id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE invitations ADD CONSTRAINT fk_invitations_org_accepted_membership
  FOREIGN KEY (org_id, accepted_membership_id) REFERENCES organization_members (org_id, id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE invitations ADD CONSTRAINT fk_invitations_org_revoked_by_membership
  FOREIGN KEY (org_id, revoked_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE invitations VALIDATE CONSTRAINT fk_invitations_org_inviter_membership;
--> statement-breakpoint
ALTER TABLE invitations VALIDATE CONSTRAINT fk_invitations_org_accepted_membership;
--> statement-breakpoint
ALTER TABLE invitations VALIDATE CONSTRAINT fk_invitations_org_revoked_by_membership;
