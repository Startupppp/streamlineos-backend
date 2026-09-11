-- Revert 1071: put both foreign keys back the way the catalog had them.
--
-- Run only during an approved rollback. This reinstates a real defect:
-- org_units.parent_id returns to ON DELETE SET NULL, so deleting a parent unit
-- SILENTLY ORPHANS its children — parent_id is nulled, the child is re-rooted at the
-- top of the tree, and nothing raises. Root CLAUDE.md §8 requires a hierarchy delete
-- to be blocked and its dependencies enumerated, so a workspace left in this state
-- needs the release authority's compensating control.
--
-- organization_people returns from RESTRICT to NO ACTION. Both refuse the delete and
-- neither constraint is deferrable, so that half is a catalog-exactness revert with no
-- behavioural consequence.
--
-- Neither direction can fail validation: both constraints already enforce referential
-- integrity, so no existing row violates either shape. SET NULL carries its column
-- list because org_id is NOT NULL and a bare SET NULL would raise 23502 on the first
-- parent deletion instead of clearing the pointer.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.org_units
  DROP CONSTRAINT IF EXISTS fk_org_units_parent_id_org;
--> statement-breakpoint

ALTER TABLE public.org_units
  ADD CONSTRAINT fk_org_units_parent_id_org
  FOREIGN KEY (org_id, parent_id)
  REFERENCES public.org_units(org_id, id)
  ON DELETE SET NULL (parent_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE public.org_units
  VALIDATE CONSTRAINT fk_org_units_parent_id_org;
--> statement-breakpoint

ALTER TABLE public.organization_people
  DROP CONSTRAINT IF EXISTS fk_organization_people_organization_membership_id_org;
--> statement-breakpoint

ALTER TABLE public.organization_people
  ADD CONSTRAINT fk_organization_people_organization_membership_id_org
  FOREIGN KEY (organization_id, organization_membership_id)
  REFERENCES public.organization_members(org_id, id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE public.organization_people
  VALIDATE CONSTRAINT fk_organization_people_organization_membership_id_org;
