-- AR-02: Promote build module self-referential FKs to composite (org_id, child_id) -> (org_id, id).
-- Each composite FK uses NOT VALID / VALIDATE to avoid ACCESS EXCLUSIVE during backfill.
-- SET NULL cases use PG15+ column-list syntax so only the child col is nulled (org_id is NOT NULL).
-- CRM and Inventory are excluded from this migration by design (see PRD-IN-SCOPE.md §4).

SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- build.tickets: epic_id / parent_ticket_id / recurrence_parent_id
-- ---------------------------------------------------------------------------
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS tickets_epic_id_tickets_id_fk;
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS tickets_parent_ticket_id_tickets_id_fk;
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS tickets_recurrence_parent_id_tickets_id_fk;

ALTER TABLE build.tickets
  ADD CONSTRAINT fk_tickets_org_epic
  FOREIGN KEY (org_id, epic_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (epic_id)
  NOT VALID;
--> statement-breakpoint
VALIDATE CONSTRAINT fk_tickets_org_epic;
--> statement-breakpoint

ALTER TABLE build.tickets
  ADD CONSTRAINT fk_tickets_org_parent
  FOREIGN KEY (org_id, parent_ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (parent_ticket_id)
  NOT VALID;
--> statement-breakpoint
VALIDATE CONSTRAINT fk_tickets_org_parent;
--> statement-breakpoint

ALTER TABLE build.tickets
  ADD CONSTRAINT fk_tickets_org_recurrence_parent
  FOREIGN KEY (org_id, recurrence_parent_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (recurrence_parent_id)
  NOT VALID;
--> statement-breakpoint
VALIDATE CONSTRAINT fk_tickets_org_recurrence_parent;

-- ---------------------------------------------------------------------------
-- build.okr_goals: parent_goal_id
-- ---------------------------------------------------------------------------
ALTER TABLE build.okr_goals DROP CONSTRAINT IF EXISTS okr_goals_parent_goal_id_okr_goals_id_fk;

ALTER TABLE build.okr_goals
  ADD CONSTRAINT fk_okr_goals_org_parent
  FOREIGN KEY (org_id, parent_goal_id)
  REFERENCES build.okr_goals (org_id, id)
  ON DELETE SET NULL (parent_goal_id)
  NOT VALID;
--> statement-breakpoint
VALIDATE CONSTRAINT fk_okr_goals_org_parent;

-- ---------------------------------------------------------------------------
-- build.pages: parent_page_id
-- ---------------------------------------------------------------------------
ALTER TABLE build.pages DROP CONSTRAINT IF EXISTS pages_parent_page_id_pages_id_fk;

ALTER TABLE build.pages
  ADD CONSTRAINT fk_pages_org_parent
  FOREIGN KEY (org_id, parent_page_id)
  REFERENCES build.pages (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
VALIDATE CONSTRAINT fk_pages_org_parent;

-- ---------------------------------------------------------------------------
-- build_events.ticket_comments: parent_comment_id
-- ---------------------------------------------------------------------------
ALTER TABLE build_events.ticket_comments DROP CONSTRAINT IF EXISTS ticket_comments_parent_comment_id_ticket_comments_id_fk;

ALTER TABLE build_events.ticket_comments
  ADD CONSTRAINT fk_ticket_comments_org_parent
  FOREIGN KEY (org_id, parent_comment_id)
  REFERENCES build_events.ticket_comments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
VALIDATE CONSTRAINT fk_ticket_comments_org_parent;
