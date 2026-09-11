-- 1053 — inv_user_warehouses' membership foreign key becomes ON DELETE CASCADE, so a
--        warehouse-access grant dies with the membership it was granted to.
--
-- @data-loss  This migration deletes access-grant rows whose member is already gone.
--             See "EXISTING DAMAGE" below; a rollback file accompanies it for the
--             constraint half, which is reversible. The deleted rows are not.
--
-- WHAT WAS WRONG. `MEMBERSHIP_ARTIFACTS` rules this artifact `onRemoval: "cascade"` and its
-- reason states the composite foreign key IS `ON DELETE CASCADE`, "so the warehouse access
-- grant row is removed with the membership automatically". Measured at journal head 674:
--
--   inv_user_warehouses.fk_inv_user_wh_user_mbr   confdeltype = 'n'  (SET NULL)
--                                                 confdelsetcols = (user_membership_id)
--
-- So removing a member does not remove their warehouse access — it NULLs the pointer and
-- leaves the grant row behind. That is the wrong shape twice over:
--
--   1. It is an ACL row. backend/CLAUDE.md §3 rules a physical delete correct for join and
--      link rows, and this is one: it carries no state of its own beyond "this member may
--      use this warehouse". A grant that belongs to nobody is not history, it is residue.
--   2. Any read that counts or lists grants per warehouse now counts rows with no member.
--      SET NULL turned a revocation into a phantom grant rather than into nothing.
--
-- WHY CASCADE AND NOT A NULLABILITY CHANGE. The declared intent — in the inventory and in
-- the constitution's rule for join rows — is that the row goes away. CASCADE is what that
-- means. It is also what the Drizzle declaration will state after this change, so the three
-- sources (declaration, migration, catalog) agree for the first time.
--
-- EXISTING DAMAGE. Rows already orphaned by the SET NULL behaviour keep a NULL
-- user_membership_id forever; CASCADE only governs future deletes. Those rows are removed
-- here because they are unreachable by construction — the grant names no member, so no
-- authorization path can ever match one, and leaving them only inflates per-warehouse
-- counts. The count is reported by the migration rather than assumed.
--
-- LOCKING. ADD CONSTRAINT ... FOREIGN KEY takes ACCESS EXCLUSIVE on both tables, so the
-- constraint is added NOT VALID and validated separately (backend/CLAUDE.md §3).

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  orphans bigint;
BEGIN
  SELECT count(*) INTO orphans FROM inv_user_warehouses WHERE user_membership_id IS NULL;
  RAISE NOTICE '1053: removing % orphaned inv_user_warehouses grant row(s) with no member', orphans;
END $$;
--> statement-breakpoint

DELETE FROM "inv_user_warehouses" WHERE "user_membership_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "inv_user_warehouses"
  DROP CONSTRAINT IF EXISTS "fk_inv_user_wh_user_mbr";
--> statement-breakpoint

ALTER TABLE "inv_user_warehouses"
  ADD CONSTRAINT "fk_inv_user_wh_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "inv_user_warehouses"
  VALIDATE CONSTRAINT "fk_inv_user_wh_user_mbr";
--> statement-breakpoint

-- Read the catalog back rather than trusting completion: db:migrate reports success over a
-- statement that did nothing.
DO $$
DECLARE
  del char;
  ok boolean;
BEGIN
  SELECT c.confdeltype, c.convalidated INTO del, ok
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE c.conname = 'fk_inv_user_wh_user_mbr' AND c.contype = 'f' AND r.relname = 'inv_user_warehouses';

  IF del IS NULL THEN
    RAISE EXCEPTION '1053: fk_inv_user_wh_user_mbr does not exist after this migration';
  END IF;
  IF del <> 'c' OR NOT ok THEN
    RAISE EXCEPTION '1053: fk_inv_user_wh_user_mbr confdeltype=% validated=% (expected c / true)', del, ok;
  END IF;
  IF EXISTS (SELECT 1 FROM inv_user_warehouses WHERE user_membership_id IS NULL) THEN
    RAISE EXCEPTION '1053: inv_user_warehouses still holds grant rows with no member';
  END IF;
END $$;
