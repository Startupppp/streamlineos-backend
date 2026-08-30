SET lock_timeout = '5s';
--> statement-breakpoint
-- SF-1: event_attendees AUTHORITY → CASCADE (link row deleted with member)
ALTER TABLE event_attendees DROP CONSTRAINT IF EXISTS fk_event_attendees_org_membership;
--> statement-breakpoint
ALTER TABLE event_attendees ADD CONSTRAINT fk_event_attendees_org_membership
  FOREIGN KEY (org_id, membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE event_attendees VALIDATE CONSTRAINT fk_event_attendees_org_membership;
--> statement-breakpoint
-- SF-2: tickets ATTRIBUTION → SET NULL (historical record survives)
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS fk_tickets_assignee_actor;
--> statement-breakpoint
ALTER TABLE build.tickets ADD CONSTRAINT fk_tickets_assignee_actor
  FOREIGN KEY (org_id, assignee_membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE build.tickets VALIDATE CONSTRAINT fk_tickets_assignee_actor;
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS fk_tickets_reporter_actor;
--> statement-breakpoint
ALTER TABLE build.tickets ADD CONSTRAINT fk_tickets_reporter_actor
  FOREIGN KEY (org_id, reporter_membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE build.tickets VALIDATE CONSTRAINT fk_tickets_reporter_actor;
--> statement-breakpoint
-- SF-3: ticket_assignees AUTHORITY → CASCADE
ALTER TABLE build.ticket_assignees DROP CONSTRAINT IF EXISTS fk_ticket_assignees_member_actor;
--> statement-breakpoint
ALTER TABLE build.ticket_assignees ADD CONSTRAINT fk_ticket_assignees_member_actor
  FOREIGN KEY (org_id, membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_assignees VALIDATE CONSTRAINT fk_ticket_assignees_member_actor;
--> statement-breakpoint
-- SF-4: project_members AUTHORITY → CASCADE
ALTER TABLE build.project_members DROP CONSTRAINT IF EXISTS fk_project_members_member_actor;
--> statement-breakpoint
ALTER TABLE build.project_members ADD CONSTRAINT fk_project_members_member_actor
  FOREIGN KEY (org_id, membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_members VALIDATE CONSTRAINT fk_project_members_member_actor;
--> statement-breakpoint
-- SF-5: project_approvals ATTRIBUTION → SET NULL
ALTER TABLE build.project_approvals DROP CONSTRAINT IF EXISTS fk_project_approvals_approver_actor;
--> statement-breakpoint
ALTER TABLE build.project_approvals ADD CONSTRAINT fk_project_approvals_approver_actor
  FOREIGN KEY (org_id, approver_membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_approvals VALIDATE CONSTRAINT fk_project_approvals_approver_actor;
--> statement-breakpoint
-- SF-6: wfh_requests ATTRIBUTION → SET NULL
ALTER TABLE wfh_requests DROP CONSTRAINT IF EXISTS fk_wfh_requests_approver_actor;
--> statement-breakpoint
ALTER TABLE wfh_requests ADD CONSTRAINT fk_wfh_requests_approver_actor
  FOREIGN KEY (org_id, approver_membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE wfh_requests VALIDATE CONSTRAINT fk_wfh_requests_approver_actor;
--> statement-breakpoint
-- SF-7: helpdesk_tickets ATTRIBUTION → SET NULL
ALTER TABLE helpdesk_tickets DROP CONSTRAINT IF EXISTS fk_helpdesk_tickets_assignee_actor;
--> statement-breakpoint
ALTER TABLE helpdesk_tickets ADD CONSTRAINT fk_helpdesk_tickets_assignee_actor
  FOREIGN KEY (org_id, assignee_membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE helpdesk_tickets VALIDATE CONSTRAINT fk_helpdesk_tickets_assignee_actor;
--> statement-breakpoint
-- SF-8: leave_requests ATTRIBUTION → SET NULL (approver + created_by + updated_by)
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS fk_leave_requests_approver_actor;
--> statement-breakpoint
ALTER TABLE leave_requests ADD CONSTRAINT fk_leave_requests_approver_actor
  FOREIGN KEY (org_id, approver_membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE leave_requests VALIDATE CONSTRAINT fk_leave_requests_approver_actor;
--> statement-breakpoint
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS fk_leave_requests_created_actor;
--> statement-breakpoint
ALTER TABLE leave_requests ADD CONSTRAINT fk_leave_requests_created_actor
  FOREIGN KEY (org_id, created_by_membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE leave_requests VALIDATE CONSTRAINT fk_leave_requests_created_actor;
--> statement-breakpoint
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS fk_leave_requests_updated_actor;
--> statement-breakpoint
ALTER TABLE leave_requests ADD CONSTRAINT fk_leave_requests_updated_actor
  FOREIGN KEY (org_id, updated_by_membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE leave_requests VALIDATE CONSTRAINT fk_leave_requests_updated_actor;
--> statement-breakpoint
-- SF-9: performance_reviews ATTRIBUTION → SET NULL
ALTER TABLE performance_reviews DROP CONSTRAINT IF EXISTS fk_performance_reviews_reviewer_actor;
--> statement-breakpoint
ALTER TABLE performance_reviews ADD CONSTRAINT fk_performance_reviews_reviewer_actor
  FOREIGN KEY (org_id, reviewer_membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE performance_reviews VALIDATE CONSTRAINT fk_performance_reviews_reviewer_actor;
--> statement-breakpoint
-- SF-10: chat_channel_members AUTHORITY → CASCADE (no existing FK, add fresh)
ALTER TABLE chat_channel_members DROP CONSTRAINT IF EXISTS fk_chat_channel_members_org_membership;
--> statement-breakpoint
ALTER TABLE chat_channel_members ADD CONSTRAINT fk_chat_channel_members_org_membership
  FOREIGN KEY (org_id, membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE chat_channel_members VALIDATE CONSTRAINT fk_chat_channel_members_org_membership;
--> statement-breakpoint
-- SF-11: chat_message_reactions already CASCADE — no change needed
-- SF-12: kb_pages owner/created already SET NULL — fix remaining attribution FKs
ALTER TABLE kb_pages DROP CONSTRAINT IF EXISTS fk_kb_pages_org_edited_membership;
--> statement-breakpoint
ALTER TABLE kb_pages ADD CONSTRAINT fk_kb_pages_org_edited_membership
  FOREIGN KEY (org_id, last_edited_by_membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE kb_pages VALIDATE CONSTRAINT fk_kb_pages_org_edited_membership;
--> statement-breakpoint
ALTER TABLE kb_pages DROP CONSTRAINT IF EXISTS fk_kb_pages_org_deleted_membership;
--> statement-breakpoint
ALTER TABLE kb_pages ADD CONSTRAINT fk_kb_pages_org_deleted_membership
  FOREIGN KEY (org_id, deleted_by_membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE kb_pages VALIDATE CONSTRAINT fk_kb_pages_org_deleted_membership;
--> statement-breakpoint
ALTER TABLE kb_pages DROP CONSTRAINT IF EXISTS fk_kb_pages_org_verified_membership;
--> statement-breakpoint
ALTER TABLE kb_pages ADD CONSTRAINT fk_kb_pages_org_verified_membership
  FOREIGN KEY (org_id, verified_by_membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE kb_pages VALIDATE CONSTRAINT fk_kb_pages_org_verified_membership;
--> statement-breakpoint
-- SF-13: kb_page_favorites and kb_page_visits ATTRIBUTION → CASCADE (personal data, not authority)
ALTER TABLE kb_page_favorites DROP CONSTRAINT IF EXISTS fk_kb_page_favorites_org_membership;
--> statement-breakpoint
ALTER TABLE kb_page_favorites ADD CONSTRAINT fk_kb_page_favorites_org_membership
  FOREIGN KEY (org_id, membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE kb_page_favorites VALIDATE CONSTRAINT fk_kb_page_favorites_org_membership;
--> statement-breakpoint
ALTER TABLE kb_page_visits DROP CONSTRAINT IF EXISTS fk_kb_page_visits_org_membership;
--> statement-breakpoint
ALTER TABLE kb_page_visits ADD CONSTRAINT fk_kb_page_visits_org_membership
  FOREIGN KEY (org_id, membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE kb_page_visits VALIDATE CONSTRAINT fk_kb_page_visits_org_membership;
--> statement-breakpoint
-- expenses: ATTRIBUTION → SET NULL
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS fk_expenses_approver_actor;
--> statement-breakpoint
ALTER TABLE expenses ADD CONSTRAINT fk_expenses_approver_actor
  FOREIGN KEY (org_id, approver_membership_id) REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE expenses VALIDATE CONSTRAINT fk_expenses_approver_actor;
