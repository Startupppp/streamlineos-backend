-- High-traffic composite indexes for 10M scale

-- Attendance: most queried table — daily lookups by user+org+date
CREATE INDEX IF NOT EXISTS "idx_attendance_org_user_date" ON "attendance" ("org_id", "user_id", "date");

-- Leave requests: frequent status + date range queries
CREATE INDEX IF NOT EXISTS "idx_leave_requests_org_status_date" ON "leave_requests" ("org_id", "status", "start_date");

-- Payrolls: queried by org + month constantly
CREATE INDEX IF NOT EXISTS "idx_payrolls_org_user_month" ON "payrolls" ("org_id", "user_id", "month");

-- WFH: pending approvals queried by admins
CREATE INDEX IF NOT EXISTS "idx_wfh_org_status" ON "wfh_requests" ("org_id", "status");

-- Holidays: queried by org + date range
CREATE INDEX IF NOT EXISTS "idx_holidays_org_date" ON "holidays" ("org_id", "date");

-- Helpdesk: filtered by org + status
CREATE INDEX IF NOT EXISTS "idx_helpdesk_org_status" ON "helpdesk_tickets" ("org_id", "status");

-- Expenses: filtered by org + user + status + date
CREATE INDEX IF NOT EXISTS "idx_expenses_org_user_status_date" ON "expenses" ("org_id", "user_id", "status", "expense_date");

-- Performance reviews: queried by org + user + cycle
CREATE INDEX IF NOT EXISTS "idx_perf_reviews_org_user" ON "performance_reviews" ("org_id", "user_id");

-- Recognitions: feed sorted by org + created
CREATE INDEX IF NOT EXISTS "idx_recognitions_org_created" ON "recognitions" ("org_id", "created_at" DESC);

-- Resignations: active ones queried frequently
CREATE INDEX IF NOT EXISTS "idx_resignations_org_status" ON "resignations" ("org_id", "status");

-- Reimbursements: pending approvals
CREATE INDEX IF NOT EXISTS "idx_reimbursements_org_status" ON "reimbursements" ("org_id", "status");

-- Salary loans: active loans
CREATE INDEX IF NOT EXISTS "idx_loans_org_status" ON "salary_loans" ("org_id", "status");

-- Policy acknowledgments: pending ones
CREATE INDEX IF NOT EXISTS "idx_policy_ack_org_status" ON "policy_acknowledgments" ("org_id", "status");

-- Training enrollments: user's enrollments
CREATE INDEX IF NOT EXISTS "idx_enrollments_org_user" ON "training_enrollments" ("org_id", "user_id");

-- Certifications: expiry alerts
CREATE INDEX IF NOT EXISTS "idx_certs_org_expiry" ON "certifications" ("org_id", "expiry_date");

-- Background verifications: pending
CREATE INDEX IF NOT EXISTS "idx_bgv_org_status" ON "background_verifications" ("org_id", "status");

-- Bonuses: by user + status
CREATE INDEX IF NOT EXISTS "idx_bonuses_org_status" ON "bonuses" ("org_id", "status");

-- F&F: by user + status
CREATE INDEX IF NOT EXISTS "idx_fnf_org_status" ON "fnf_settlements" ("org_id", "status");

-- eNPS: by org + period for aggregation
CREATE INDEX IF NOT EXISTS "idx_enps_org_period" ON "enps_scores" ("org_id", "period");

-- Feedback requests: by reviewer (for pending feedback)
CREATE INDEX IF NOT EXISTS "idx_feedback_org_reviewer" ON "feedback_requests" ("org_id", "reviewer_user_id", "is_completed");

-- Survey responses: by survey for aggregation
CREATE INDEX IF NOT EXISTS "idx_survey_responses_survey_id" ON "survey_responses" ("survey_id");

-- Team events: by org + date
CREATE INDEX IF NOT EXISTS "idx_team_events_org_date" ON "team_events" ("org_id", "date");
