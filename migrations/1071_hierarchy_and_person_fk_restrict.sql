-- 1071: make two membership/hierarchy foreign keys act the way the schema declares.
--
-- Found by `check:referential-action-drift` run against a database at journal head.
-- Both constraints were baselined as accepted drift; neither is.
--
-- 1. org_units.fk_org_units_parent_id_org
--    Declared `.onDelete("restrict")` in src/db/schema/common/organization.ts:78.
--    Live: ON DELETE SET NULL (parent_id).
--    Deleting a parent unit therefore SILENTLY ORPHANS its children -- parent_id is
--    nulled and the child is re-rooted at the top of the tree with no error and no
--    audit trail. Root CLAUDE.md §8 says the hierarchy is archive/restore, never hard
--    delete, and that a dependency conflict must block and list its dependencies. A
--    foreign key that quietly re-parents is the opposite of that rule.
--
-- 2. organization_people.fk_organization_people_organization_membership_id_org
--    Declared `.onDelete("restrict")` in src/db/schema/directory/organization-people.ts:104.
--    Live: NO ACTION.
--    MEMBERSHIP_ARTIFACTS records this one as `onRemoval: "blocks-removal"`. NO ACTION
--    already blocks, so this half is an exactness fix, not a behaviour change: it makes
--    the catalog say what the schema and the artifact registry both already say.
--
-- MEASURED BEFORE WRITING THIS, on a scratch database, in rolled-back transactions,
-- reproducing each constraint's exact shape on temp tables:
--
--   self-referential composite FK (org_units shape)
--     SET NULL   delete parent -> ALLOWED, child.parent_id = null   <- the defect
--     NO ACTION  delete parent -> REFUSED 23503
--     RESTRICT   delete parent -> REFUSED 23001
--
--   sibling-of-a-cascading-parent FK (organization_people shape)
--     NO ACTION  delete membership -> REFUSED 23503
--     RESTRICT   delete membership -> REFUSED 23001
--
-- The cascade from organizations was checked in BOTH shapes and under BOTH actions:
-- deleting the organization still removes every row (units left = 0; person = 0,
-- member = 0). RESTRICT is checked immediately rather than at end of statement, so
-- the concern was that it would break org deletion and every erasure drill with it.
-- It does not, because those rows leave through their own org_id CASCADE. This was
-- verified rather than assumed -- the doctrine reading suggested the opposite.
--
-- Neither change can fail validation: the old constraints already enforced
-- referential integrity, so no existing row violates the new ones. ADD ... NOT VALID
-- followed by VALIDATE keeps the ACCESS EXCLUSIVE window to the catalog update.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.org_units
  DROP CONSTRAINT IF EXISTS fk_org_units_parent_id_org;
--> statement-breakpoint

ALTER TABLE public.org_units
  ADD CONSTRAINT fk_org_units_parent_id_org
  FOREIGN KEY (org_id, parent_id)
  REFERENCES public.org_units(org_id, id)
  ON DELETE RESTRICT
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
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint

ALTER TABLE public.organization_people
  VALIDATE CONSTRAINT fk_organization_people_organization_membership_id_org;
