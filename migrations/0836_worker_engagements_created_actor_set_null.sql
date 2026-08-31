-- 0836: Change worker_engagements.created_by_membership_id FK from RESTRICT to SET NULL.
--
-- Ruling: CHANGE TO SET NULL.
-- This FK was added in migration 0815 as RESTRICT. The column records who created
-- the engagement record; it is attribution, not authority. The engagement itself
-- must survive after the creating member leaves. No parallel user column exists,
-- so after removal the UI should render a placeholder (e.g. "Former member").
-- Note: updated_by_membership_id and archived_by_membership_id FKs are pending
-- (hrms-phase1) and not yet in the DB; they will be authored as SET NULL directly
-- when that migration is applied.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.worker_engagements
  DROP CONSTRAINT IF EXISTS fk_worker_engagements_created_actor;
--> statement-breakpoint
ALTER TABLE public.worker_engagements
  ADD CONSTRAINT fk_worker_engagements_created_actor
    FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (created_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.worker_engagements
  VALIDATE CONSTRAINT fk_worker_engagements_created_actor;
--> statement-breakpoint

DO $$
DECLARE
  wrong_del text;
BEGIN
  SELECT c.confdeltype INTO wrong_del
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE c.conname = 'fk_worker_engagements_created_actor' AND c.contype = 'f'
    AND r.relname = 'worker_engagements';
  IF wrong_del IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION '0836: fk_worker_engagements_created_actor confdeltype = % (expected n)', wrong_del;
  END IF;
END $$;
