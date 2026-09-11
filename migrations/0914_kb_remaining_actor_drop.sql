-- 0914: finish KB creator and article-restriction actor contraction.
SET lock_timeout = '5s';
--> statement-breakpoint

-- Backfill space creators in resume-safe batches.
DO $$
DECLARE updated_count integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT ks.id
      FROM kb_spaces ks
      WHERE ks.created_by_id IS NOT NULL
        AND ks.created_by_membership_id IS NULL
        AND EXISTS (
          SELECT 1 FROM organization_members om
          WHERE om.org_id = ks.org_id AND om.user_id = ks.created_by_id
        )
      ORDER BY ks.id
      LIMIT 1000
    )
    UPDATE kb_spaces ks
    SET created_by_membership_id = (
      SELECT om.id FROM organization_members om
      WHERE om.org_id = ks.org_id AND om.user_id = ks.created_by_id
      ORDER BY (om.status = 'ACTIVE') DESC, om.id DESC
      LIMIT 1
    )
    FROM batch
    WHERE ks.id = batch.id;
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    EXIT WHEN updated_count = 0;
  END LOOP;
END $$;
--> statement-breakpoint

-- Backfill explicit user restrictions; role/team grants intentionally stay NULL.
DO $$
DECLARE updated_count integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT kar.id
      FROM kb_article_restrictions kar
      WHERE kar.user_id IS NOT NULL
        AND kar.membership_id IS NULL
        AND EXISTS (
          SELECT 1 FROM organization_members om
          WHERE om.org_id = kar.org_id AND om.user_id = kar.user_id
        )
      ORDER BY kar.id
      LIMIT 1000
    )
    UPDATE kb_article_restrictions kar
    SET membership_id = (
      SELECT om.id FROM organization_members om
      WHERE om.org_id = kar.org_id AND om.user_id = kar.user_id
      ORDER BY (om.status = 'ACTIVE') DESC, om.id DESC
      LIMIT 1
    )
    FROM batch
    WHERE kar.id = batch.id;
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    EXIT WHEN updated_count = 0;
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  unmappable_spaces integer;
  unmappable_restrictions integer;
BEGIN
  SELECT count(*)::integer INTO unmappable_spaces
  FROM kb_spaces
  WHERE created_by_id IS NOT NULL AND created_by_membership_id IS NULL;

  SELECT count(*)::integer INTO unmappable_restrictions
  FROM kb_article_restrictions
  WHERE user_id IS NOT NULL AND membership_id IS NULL;

  IF unmappable_spaces > 0 OR unmappable_restrictions > 0 THEN
    RAISE EXCEPTION
      '0914: unmappable KB actors: spaces=%, article_restrictions=%',
      unmappable_spaces, unmappable_restrictions;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE kb_article_restrictions
  DROP CONSTRAINT IF EXISTS fk_kb_article_restrictions_org_membership;
--> statement-breakpoint

ALTER TABLE kb_article_restrictions
  ADD CONSTRAINT fk_kb_article_restrictions_org_membership
  FOREIGN KEY (org_id, membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint

ALTER TABLE kb_article_restrictions
  VALIDATE CONSTRAINT fk_kb_article_restrictions_org_membership;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_kb_article_restrictions_user;
--> statement-breakpoint

ALTER TABLE kb_article_restrictions
  DROP CONSTRAINT IF EXISTS kb_article_restrictions_user_id_users_id_fk;
--> statement-breakpoint

ALTER TABLE kb_article_restrictions
  DROP COLUMN IF EXISTS user_id;
--> statement-breakpoint

ALTER TABLE kb_spaces
  DROP CONSTRAINT IF EXISTS kb_spaces_created_by_id_users_id_fk;
--> statement-breakpoint

ALTER TABLE kb_spaces
  DROP COLUMN IF EXISTS created_by_id;
