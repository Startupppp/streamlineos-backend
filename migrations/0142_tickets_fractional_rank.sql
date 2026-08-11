-- Custom SQL migration file, put your code below! --
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE tickets ADD COLUMN rank numeric;
--> statement-breakpoint
UPDATE tickets SET rank = ("order" + 1) * 1000;
--> statement-breakpoint
ALTER TABLE tickets ALTER COLUMN rank SET NOT NULL;
--> statement-breakpoint
ALTER TABLE tickets ALTER COLUMN rank SET DEFAULT 1000;
--> statement-breakpoint
CREATE INDEX idx_tickets_org_project_rank ON tickets (org_id, project_id, rank);
--> statement-breakpoint
DROP INDEX IF EXISTS idx_tickets_org_project_order;
--> statement-breakpoint
ALTER TABLE tickets DROP COLUMN "order";
