SET statement_timeout = 0;
-- 0336 — replace text[] array columns with normalized child tables
-- =============================================================================
-- kb_articles.tags text[]
--   → kb_tags (tag entity, org-scoped) + kb_article_tags (article↔tag join)
--   Both child tables already exist and are the authoritative store used by
--   kb-tags.service.ts. This migration removes the now-redundant denormalized
--   array column.
--
-- hr_employee_profiles.skills text[]
--   → employee_skills (richer: carries level, verified flag, endorsements)
--   employee_skills already exists and is already the authoritative store used
--   by employee-mutations.service.ts and employee-skills.service.ts. The array
--   on hr_employee_profiles was a shadow copy that drifted.
--
-- Backfill logic is correct on an EMPTY database (UNNEST / LATERAL of a NULL
-- or empty array emits zero rows) and also correct on a populated one.
-- =============================================================================

-- 1. Upsert distinct tag names from kb_articles.tags into kb_tags.
--    The slug mirrors kbSlugify: lower-trim, replace non-alphanumeric runs
--    with a hyphen, strip leading/trailing hyphens.
INSERT INTO kb_tags (org_id, name, slug, created_at)
SELECT DISTINCT
  a.org_id,
  t.name,
  regexp_replace(
    regexp_replace(
      regexp_replace(lower(trim(t.name)), '[^a-z0-9]+', '-', 'g'),
      '^-+', ''
    ),
    '-+$', ''
  ),
  now()
FROM kb_articles a
CROSS JOIN LATERAL unnest(a.tags) AS t(name)
WHERE a.tags IS NOT NULL AND cardinality(a.tags) > 0
ON CONFLICT (org_id, slug) DO NOTHING;

--> statement-breakpoint

-- 2. Populate kb_article_tags from kb_articles.tags, resolving tag names to
--    the tag IDs just upserted above.
INSERT INTO kb_article_tags (article_id, tag_id)
SELECT DISTINCT
  a.id,
  kt.id
FROM kb_articles a
CROSS JOIN LATERAL unnest(a.tags) AS t(name)
JOIN kb_tags kt
  ON kt.org_id = a.org_id
  AND kt.slug = regexp_replace(
    regexp_replace(
      regexp_replace(lower(trim(t.name)), '[^a-z0-9]+', '-', 'g'),
      '^-+', ''
    ),
    '-+$', ''
  )
WHERE a.tags IS NOT NULL AND cardinality(a.tags) > 0
ON CONFLICT (article_id, tag_id) DO NOTHING;

--> statement-breakpoint

-- 3. Drop the denormalized tags array from kb_articles.
ALTER TABLE "kb_articles" DROP COLUMN IF EXISTS "tags";

--> statement-breakpoint

-- 4. Backfill employee_skills from hr_employee_profiles.skills.
--    Navigation path: hr_employee_profiles.employment_id
--                     → hr_employments.person_id
--                     → hr_people.user_id
--    Insert only rows that do not already exist (employee_skills has no unique
--    constraint on (org_id, user_id, skill_name), so guard with NOT EXISTS).
INSERT INTO employee_skills (org_id, user_id, skill_name, level, created_at)
SELECT DISTINCT
  ep.org_id,
  hp.user_id,
  s.skill_name,
  1,
  now()
FROM hr_employee_profiles ep
JOIN hr_employments e  ON e.id = ep.employment_id AND e.deleted_at IS NULL
JOIN hr_people hp      ON hp.id = e.person_id     AND hp.deleted_at IS NULL
                       AND hp.user_id IS NOT NULL
CROSS JOIN LATERAL unnest(ep.skills) AS s(skill_name)
WHERE ep.skills IS NOT NULL AND cardinality(ep.skills) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM employee_skills es2
    WHERE es2.org_id     = ep.org_id
      AND es2.user_id    = hp.user_id
      AND es2.skill_name = s.skill_name
  );

--> statement-breakpoint

-- 5. Drop the denormalized skills array from hr_employee_profiles.
ALTER TABLE "hr_employee_profiles" DROP COLUMN IF EXISTS "skills";
