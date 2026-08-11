-- Rollback for 0416_tickets_soft_delete_and_version
-- Fully reversible: both columns were additive and no data depends on them.
-- Restores the non-partial rank index that 0416 replaced.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS idx_tickets_org_project_rank;
--> statement-breakpoint
CREATE INDEX idx_tickets_org_project_rank ON tickets (org_id, project_id, rank);
--> statement-breakpoint
ALTER TABLE tickets DROP COLUMN IF EXISTS deleted_at;
--> statement-breakpoint
ALTER TABLE tickets DROP COLUMN IF EXISTS version;
