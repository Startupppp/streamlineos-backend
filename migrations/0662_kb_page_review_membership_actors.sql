SET lock_timeout = '5s';

ALTER TABLE kb_page_reviews
  ADD COLUMN IF NOT EXISTS requested_by_membership_id INTEGER,
  ADD COLUMN IF NOT EXISTS reviewer_membership_id INTEGER;

UPDATE kb_page_reviews review
SET requested_by_membership_id = member.id
FROM organization_members member
WHERE member.org_id = review.org_id
  AND member.user_id = review.requested_by_id
  AND review.requested_by_membership_id IS NULL;

UPDATE kb_page_reviews review
SET reviewer_membership_id = member.id
FROM organization_members member
WHERE member.org_id = review.org_id
  AND member.user_id = review.reviewer_id
  AND review.reviewer_membership_id IS NULL;

INSERT INTO communication_backfill_issues (org_id, domain, source_id, reason, details)
SELECT review.org_id, 'kb_page_reviews', review.id::text, 'unmappable_requested_membership', jsonb_build_object('legacyUserId', review.requested_by_id)
FROM kb_page_reviews review
WHERE review.requested_by_id IS NOT NULL
  AND review.requested_by_membership_id IS NULL;

INSERT INTO communication_backfill_issues (org_id, domain, source_id, reason, details)
SELECT review.org_id, 'kb_page_reviews', review.id::text, 'unmappable_reviewer_membership', jsonb_build_object('legacyUserId', review.reviewer_id)
FROM kb_page_reviews review
WHERE review.reviewer_id IS NOT NULL
  AND review.reviewer_membership_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_kb_page_reviews_org_reviewer_status_due
  ON kb_page_reviews (org_id, reviewer_membership_id, status, due_at);

CREATE INDEX IF NOT EXISTS idx_kb_page_reviews_org_requester_status_due
  ON kb_page_reviews (org_id, requested_by_membership_id, status, due_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_reviews_org_requester_membership') THEN
    ALTER TABLE kb_page_reviews ADD CONSTRAINT fk_kb_page_reviews_org_requester_membership
      FOREIGN KEY (org_id, requested_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_reviews_org_reviewer_membership') THEN
    ALTER TABLE kb_page_reviews ADD CONSTRAINT fk_kb_page_reviews_org_reviewer_membership
      FOREIGN KEY (org_id, reviewer_membership_id) REFERENCES organization_members (org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

ALTER TABLE kb_page_reviews VALIDATE CONSTRAINT fk_kb_page_reviews_org_requester_membership;
ALTER TABLE kb_page_reviews VALIDATE CONSTRAINT fk_kb_page_reviews_org_reviewer_membership;
