-- Roll back only the indexes introduced by 0931. No table or row data is changed.
DROP INDEX IF EXISTS build."idx_tickets_org_project_rank_covering";
DROP INDEX IF EXISTS build."idx_tickets_org_assignee_due_live_covering";
DROP INDEX IF EXISTS build."idx_ticket_assignees_org_user_ticket";
