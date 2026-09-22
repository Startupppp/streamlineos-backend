-- Migration 1151: expression index for notifications.metadata->>'projectId' inbox filter
-- Rollback: migrations/rollback/1151_notifications_metadata_project_id_index.down.sql

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_notifications_metadata_project_id
  ON public.notifications (org_id, membership_id, (metadata->>'projectId'))
  WHERE deleted_at IS NULL AND archived_at IS NULL;
