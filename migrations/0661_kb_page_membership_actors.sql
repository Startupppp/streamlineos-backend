SET lock_timeout = '5s';

ALTER TABLE kb_page_favorites
  ADD COLUMN IF NOT EXISTS membership_id INTEGER;

ALTER TABLE kb_page_visits
  ADD COLUMN IF NOT EXISTS membership_id INTEGER;

UPDATE kb_page_favorites favorite
SET membership_id = member.id
FROM organization_members member
WHERE member.org_id = favorite.org_id
  AND member.user_id = favorite.user_id
  AND favorite.membership_id IS NULL;

UPDATE kb_page_visits visit
SET membership_id = member.id
FROM organization_members member
WHERE member.org_id = visit.org_id
  AND member.user_id = visit.user_id
  AND visit.membership_id IS NULL;

INSERT INTO communication_backfill_issues (org_id, domain, source_id, reason, details)
SELECT favorite.org_id, 'kb_page_favorites', favorite.id::text, 'unmappable_membership', jsonb_build_object('legacyUserId', favorite.user_id)
FROM kb_page_favorites favorite
WHERE favorite.membership_id IS NULL;

INSERT INTO communication_backfill_issues (org_id, domain, source_id, reason, details)
SELECT visit.org_id, 'kb_page_visits', visit.id::text, 'unmappable_membership', jsonb_build_object('legacyUserId', visit.user_id)
FROM kb_page_visits visit
WHERE visit.membership_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_page_favorites_page_membership
  ON kb_page_favorites (org_id, page_id, membership_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_page_visits_page_membership
  ON kb_page_visits (org_id, page_id, membership_id);

CREATE INDEX IF NOT EXISTS idx_kb_page_favorites_org_membership_sort
  ON kb_page_favorites (org_id, membership_id, sort_order, created_at);

CREATE INDEX IF NOT EXISTS idx_kb_page_visits_org_membership_visited
  ON kb_page_visits (org_id, membership_id, visited_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_favorites_org_membership') THEN
    ALTER TABLE kb_page_favorites ADD CONSTRAINT fk_kb_page_favorites_org_membership
      FOREIGN KEY (org_id, membership_id) REFERENCES organization_members (org_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_visits_org_membership') THEN
    ALTER TABLE kb_page_visits ADD CONSTRAINT fk_kb_page_visits_org_membership
      FOREIGN KEY (org_id, membership_id) REFERENCES organization_members (org_id, id) NOT VALID;
  END IF;
END $$;

ALTER TABLE kb_page_favorites VALIDATE CONSTRAINT fk_kb_page_favorites_org_membership;
ALTER TABLE kb_page_visits VALIDATE CONSTRAINT fk_kb_page_visits_org_membership;
