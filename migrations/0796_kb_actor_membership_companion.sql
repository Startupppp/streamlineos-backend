-- 0796 — KB space-member and article-restriction membership companions
-- =============================================================================
-- HR/KB legacy-actor programme — lane L37.
--
-- The KB ACL tables (kb_space_members, kb_article_restrictions) gate space and
-- article access by users.id directly.  That is an authority read on a legacy
-- actor column: a departed member whose user row still exists can still match
-- the membership check even after their org_member row is deactivated.
--
-- This migration adds a membership_id companion column to both tables so the
-- access service can switch to membership-keyed authority checks (dual-write
-- during transition, membership-first at read time).  The FK is NOT VALID so
-- the ALTER TABLE takes only a brief ACCESS EXCLUSIVE lock to write the
-- pg_constraint row rather than scanning every existing row; a second
-- VALIDATE CONSTRAINT runs a less-disruptive ShareUpdateExclusiveLock scan.
--
-- On DELETE SET NULL: when an org_member row is deleted the FK silently clears
-- the companion so existing rows degrade gracefully back to user_id matching
-- until the next write backfills them.
--
-- Safe to run online: two additive-only ALTER TABLE statements plus two
-- NOT VALID / VALIDATE pairs.  No table rewrites, no data movement.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE kb_space_members
  ADD COLUMN IF NOT EXISTS membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE kb_space_members
  DROP CONSTRAINT IF EXISTS fk_kb_space_members_org_membership;
--> statement-breakpoint

ALTER TABLE kb_space_members
  ADD CONSTRAINT fk_kb_space_members_org_membership
    FOREIGN KEY (org_id, membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE kb_space_members VALIDATE CONSTRAINT fk_kb_space_members_org_membership;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_kb_space_members_org_membership
  ON kb_space_members (org_id, membership_id)
  WHERE membership_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE kb_article_restrictions
  ADD COLUMN IF NOT EXISTS membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE kb_article_restrictions
  DROP CONSTRAINT IF EXISTS fk_kb_article_restrictions_org_membership;
--> statement-breakpoint

ALTER TABLE kb_article_restrictions
  ADD CONSTRAINT fk_kb_article_restrictions_org_membership
    FOREIGN KEY (org_id, membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE kb_article_restrictions VALIDATE CONSTRAINT fk_kb_article_restrictions_org_membership;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_kb_article_restrictions_org_membership
  ON kb_article_restrictions (org_id, membership_id)
  WHERE membership_id IS NOT NULL;
--> statement-breakpoint

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(conname, ', ') INTO bad
  FROM pg_constraint
  WHERE conname IN ('fk_kb_space_members_org_membership', 'fk_kb_article_restrictions_org_membership')
    AND contype = 'f'
    AND confdeltype = 'n'
    AND (confdelsetcols IS NULL OR cardinality(confdelsetcols) <> 1);

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0796: composite ON DELETE SET NULL without a single-column list would null org_id (23502): %', bad;
  END IF;
END $$;
