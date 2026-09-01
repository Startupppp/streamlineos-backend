SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tickets_org_project_rank_covering"
  ON build."tickets" ("org_id", "project_id", "rank" ASC, "created_at" DESC, "id" ASC)
  INCLUDE ("title", "status", "priority", "assignee_membership_id")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tickets_org_assignee_due_live_covering"
  ON build."tickets" ("org_id", "assignee_membership_id", "due_date" ASC NULLS LAST, "created_at" DESC, "id" ASC)
  INCLUDE ("title", "status", "priority")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ticket_assignees_org_user_ticket"
  ON build."ticket_assignees" ("org_id", "membership_id", "ticket_id");
