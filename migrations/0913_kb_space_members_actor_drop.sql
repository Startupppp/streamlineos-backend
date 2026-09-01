-- 0913: contract KB space membership authority onto organization membership.
-- Rows granted to a role/team remain valid with a NULL membership_id; user grants
-- must have a canonical membership before the legacy user_id can be removed.

SET lock_timeout = '5s';
--> statement-breakpoint

-- Resume-safe batches avoid one large update and only target user grants. Role
-- and team grants intentionally retain NULL membership_id.
DO $$
DECLARE
  updated_count integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT ksm.id
      FROM kb_space_members ksm
      WHERE ksm.user_id IS NOT NULL
        AND ksm.membership_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM organization_members om
          WHERE om.org_id = ksm.org_id
            AND om.user_id = ksm.user_id
        )
      ORDER BY ksm.id
      LIMIT 1000
    )
    UPDATE kb_space_members ksm
    SET membership_id = (
      SELECT om.id
      FROM organization_members om
      WHERE om.org_id = ksm.org_id
        AND om.user_id = ksm.user_id
      ORDER BY (om.status = 'ACTIVE') DESC, om.id DESC
      LIMIT 1
    )
    FROM batch
    WHERE ksm.id = batch.id;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    EXIT WHEN updated_count = 0;
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  unmappable_count integer;
BEGIN
  SELECT count(*)::integer
  INTO unmappable_count
  FROM kb_space_members
  WHERE user_id IS NOT NULL
    AND membership_id IS NULL;

  IF unmappable_count > 0 THEN
    RAISE EXCEPTION
      '0913: % kb_space_members user grant(s) cannot map to an organization membership',
      unmappable_count;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE kb_space_members
  DROP CONSTRAINT IF EXISTS fk_kb_space_members_org_membership;
--> statement-breakpoint

ALTER TABLE kb_space_members
  ADD CONSTRAINT fk_kb_space_members_org_membership
  FOREIGN KEY (org_id, membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint

ALTER TABLE kb_space_members
  VALIDATE CONSTRAINT fk_kb_space_members_org_membership;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_kb_space_members_user;
--> statement-breakpoint

ALTER TABLE kb_space_members
  DROP CONSTRAINT IF EXISTS kb_space_members_user_id_users_id_fk;
--> statement-breakpoint

ALTER TABLE kb_space_members
  DROP COLUMN IF EXISTS user_id;
