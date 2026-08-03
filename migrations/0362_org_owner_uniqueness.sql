SET statement_timeout = 0;
DO $$
DECLARE
  dup_detail text;
  zero_count integer;
BEGIN
  SELECT string_agg(org_id, ', ' ORDER BY org_id)
  INTO dup_detail
  FROM (
    SELECT org_id
    FROM organization_members
    WHERE is_owner = true
    GROUP BY org_id
    HAVING COUNT(*) > 1
  ) t;

  IF dup_detail IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0362 aborted: multiple is_owner=true members found in the same org. '
      'Exactly one owner per org is required. Offending org_ids: %',
      dup_detail;
  END IF;

  SELECT COUNT(DISTINCT o.id)
  INTO zero_count
  FROM organizations o
  WHERE NOT EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.org_id = o.id AND m.is_owner = true
  ) AND o.deleted_at IS NULL;

  IF zero_count > 0 THEN
    RAISE NOTICE
      'Migration 0362: % non-deleted org(s) have zero is_owner=true members — data integrity signal (partial unique index cannot enforce at-least-one).',
      zero_count;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_org_members_single_owner"
  ON "organization_members" (org_id)
  WHERE is_owner = true;
