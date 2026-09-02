-- 1040: back the two KB read-then-insert dedupes with the constraints they assume.
--
-- Two services check for an existing row and then insert, with nothing behind
-- either check. Both are the same defect as kb_page_links' record grain (1021):
-- two concurrent requests both read nothing and both insert.
--
-- 1. kb_space_members. KbMembersService.add (kb-members.service.ts:90-105)
--    dedupes on (org_id, space_id, membership_id) and, independently, on
--    (org_id, space_id, role) -- two separate checks, because one row may carry
--    both a membership and a role. The two partial uniques below are exactly
--    those two tuples, each restricted to rows where its own column is set, so
--    they do not constrain each other. This is a space ACL: a duplicate row is a
--    duplicated grant, and the second one is invisible to anyone revoking the
--    first.
--
-- 2. kb_page_templates. KbPageTemplatesService.list orders by name and the UI
--    shows nothing else, so two templates sharing a name are indistinguishable
--    to the person picking one. create() did not check at all; this makes the
--    name the per-org key it already reads as, and the service now maps 23505 to
--    409 rather than 500.
--
-- The de-duplicating DELETEs remove only rows that are IDENTICAL on every
-- meaningful column -- true duplicates, where the choice of survivor cannot
-- change anyone's access. A pair that disagrees (same member, two different
-- space_roles) is deliberately NOT resolved here: the CREATE UNIQUE INDEX will
-- fail on it, which is the correct outcome for an ACL row. Silently keeping one
-- of two conflicting grants is a permission change made by a migration.
--
-- Measured on the seeded database before writing: 0 duplicates on all three
-- tuples, so on that database both DELETEs are no-ops and both indexes build.
--
-- CREATE INDEX rather than CONCURRENTLY: drizzle-kit migrate wraps the file in a
-- transaction (discipline rule 7). lock_timeout bounds the wait.

SET lock_timeout = '5s';
--> statement-breakpoint

DELETE FROM "kb_space_members" a
USING "kb_space_members" b
WHERE a."membership_id" IS NOT NULL
  AND b."membership_id" IS NOT NULL
  AND a."org_id" = b."org_id"
  AND a."space_id" = b."space_id"
  AND a."membership_id" = b."membership_id"
  AND a."space_role" = b."space_role"
  AND a."role" IS NOT DISTINCT FROM b."role"
  AND a."team" IS NOT DISTINCT FROM b."team"
  AND a."id" > b."id";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_space_members_org_space_membership"
  ON "kb_space_members" ("org_id", "space_id", "membership_id")
  WHERE "membership_id" IS NOT NULL;
--> statement-breakpoint

DELETE FROM "kb_space_members" a
USING "kb_space_members" b
WHERE a."role" IS NOT NULL
  AND b."role" IS NOT NULL
  AND a."org_id" = b."org_id"
  AND a."space_id" = b."space_id"
  AND a."role" = b."role"
  AND a."space_role" = b."space_role"
  AND a."membership_id" IS NOT DISTINCT FROM b."membership_id"
  AND a."team" IS NOT DISTINCT FROM b."team"
  AND a."id" > b."id";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_space_members_org_space_role"
  ON "kb_space_members" ("org_id", "space_id", "role")
  WHERE "role" IS NOT NULL;
--> statement-breakpoint

DELETE FROM "kb_page_templates" a
USING "kb_page_templates" b
WHERE a."org_id" = b."org_id"
  AND a."name" = b."name"
  AND a."description" IS NOT DISTINCT FROM b."description"
  AND a."icon" IS NOT DISTINCT FROM b."icon"
  AND a."id" > b."id";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_page_templates_org_name"
  ON "kb_page_templates" ("org_id", "name");
