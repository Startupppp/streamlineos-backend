SET lock_timeout = '5s';

ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS approver_membership_id integer;
--> statement-breakpoint
UPDATE leave_requests t SET approver_membership_id = m.id FROM organization_members m WHERE m.org_id = t.org_id AND m.user_id = t.approver_id AND t.approver_membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE leave_requests ADD CONSTRAINT fk_leave_requests_approver_actor FOREIGN KEY (org_id, approver_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE leave_requests VALIDATE CONSTRAINT fk_leave_requests_approver_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leave_requests_org_approver_membership ON leave_requests (org_id, approver_membership_id);
--> statement-breakpoint
ALTER TABLE wfh_requests ADD COLUMN IF NOT EXISTS approver_membership_id integer;
--> statement-breakpoint
UPDATE wfh_requests t SET approver_membership_id = m.id FROM organization_members m WHERE m.org_id = t.org_id AND m.user_id = t.approver_id AND t.approver_membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE wfh_requests ADD CONSTRAINT fk_wfh_requests_approver_actor FOREIGN KEY (org_id, approver_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE wfh_requests VALIDATE CONSTRAINT fk_wfh_requests_approver_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_wfh_requests_org_approver_membership ON wfh_requests (org_id, approver_membership_id);
--> statement-breakpoint
ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS reviewer_membership_id integer;
--> statement-breakpoint
UPDATE performance_reviews t SET reviewer_membership_id = m.id FROM organization_members m WHERE m.org_id = t.org_id AND m.user_id = t.reviewer_id AND t.reviewer_membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE performance_reviews ADD CONSTRAINT fk_performance_reviews_reviewer_actor FOREIGN KEY (org_id, reviewer_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE performance_reviews VALIDATE CONSTRAINT fk_performance_reviews_reviewer_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_perf_reviews_org_reviewer_membership ON performance_reviews (org_id, reviewer_membership_id);
--> statement-breakpoint
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS assignee_membership_id integer;
--> statement-breakpoint
UPDATE helpdesk_tickets t SET assignee_membership_id = m.id FROM organization_members m WHERE m.org_id = t.org_id AND m.user_id = t.assignee_id AND t.assignee_membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE helpdesk_tickets ADD CONSTRAINT fk_helpdesk_tickets_assignee_actor FOREIGN KEY (org_id, assignee_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE helpdesk_tickets VALIDATE CONSTRAINT fk_helpdesk_tickets_assignee_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_org_assignee_membership ON helpdesk_tickets (org_id, assignee_membership_id);
