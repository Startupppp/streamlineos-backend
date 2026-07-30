SET statement_timeout = 0;

-- =============================================================================
-- 0366 — finish the role collapse: fix the COLUMN DEFAULTS
-- =============================================================================
-- 0363 normalised existing rows to OWNER | ORG_ADMIN | MEMBER but left the
-- column DEFAULT at 'ENGINEERING' on three tables. Any insert that omitted
-- `role` therefore wrote back the exact legacy value 0363 had just removed —
-- the collapse would have silently un-done itself over time.
--
-- Fixes the defaults and re-normalises any row that already drifted back.
-- =============================================================================

ALTER TABLE "organization_members" ALTER COLUMN "role" SET DEFAULT 'MEMBER';
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'MEMBER';
--> statement-breakpoint
ALTER TABLE "invitations" ALTER COLUMN "role" SET DEFAULT 'MEMBER';
--> statement-breakpoint

-- Re-normalise anything written since 0363 through the stale default.
UPDATE "organization_members" SET "role" = 'OWNER'
  WHERE "is_owner" = true AND "role" <> 'OWNER';
--> statement-breakpoint

UPDATE "organization_members" SET "role" = 'MEMBER'
  WHERE "is_owner" = false AND "role" NOT IN ('ORG_ADMIN', 'MEMBER');
--> statement-breakpoint

UPDATE "users" SET "role" = 'MEMBER'
  WHERE "role" NOT IN ('OWNER', 'ORG_ADMIN', 'MEMBER');
--> statement-breakpoint

UPDATE "invitations" SET "role" = 'MEMBER'
  WHERE "status" = 'PENDING' AND "role" NOT IN ('ORG_ADMIN', 'MEMBER');
--> statement-breakpoint

-- Fail loudly if anything outside the three structural values survived, rather
-- than leaving a half-collapsed role column that reads as clean.
DO $$
DECLARE
  bad_count integer;
BEGIN
  SELECT count(*) INTO bad_count
  FROM "organization_members"
  WHERE "role" NOT IN ('OWNER', 'ORG_ADMIN', 'MEMBER');

  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'organization_members.role still holds % non-structural value(s) after 0366', bad_count;
  END IF;
END $$;
