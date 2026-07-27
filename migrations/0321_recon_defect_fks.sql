-- wave-4-defect-fks.sql  (Phase B.3 — P1 tenant-integrity defect FKs)
-- Bare org_id columns that were declared NOT NULL but never FK-constrained to
-- organizations. Idempotent; guarded on pg_constraint. Tables verified empty
-- (zero orphan org_id) on the dev branch before application.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_comment_reactions_org_id_organizations_fk'
  ) THEN
    ALTER TABLE ticket_comment_reactions
      ADD CONSTRAINT ticket_comment_reactions_org_id_organizations_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_automations_org_id_organizations_fk'
  ) THEN
    ALTER TABLE project_automations
      ADD CONSTRAINT project_automations_org_id_organizations_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END$$;

COMMIT;
