SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE feedback_cycle_responses
  ADD COLUMN IF NOT EXISTS org_id text;
--> statement-breakpoint
UPDATE feedback_cycle_responses r
SET org_id = fcr.org_id
FROM feedback_cycle_requests fcr
WHERE r.request_id = fcr.id;
--> statement-breakpoint
ALTER TABLE feedback_cycle_responses
  ADD CONSTRAINT chk_fcr_org_id_not_null
  CHECK (org_id IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE feedback_cycle_responses
  VALIDATE CONSTRAINT chk_fcr_org_id_not_null;
--> statement-breakpoint
ALTER TABLE feedback_cycle_responses
  ALTER COLUMN org_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE feedback_cycle_responses
  DROP CONSTRAINT chk_fcr_org_id_not_null;
--> statement-breakpoint
ALTER TABLE feedback_cycle_responses
  ADD CONSTRAINT fk_feedback_cycle_responses_org
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE feedback_cycle_responses
  VALIDATE CONSTRAINT fk_feedback_cycle_responses_org;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_feedback_cycle_responses_org_request
  ON feedback_cycle_responses(org_id, request_id);
--> statement-breakpoint
ALTER TABLE feedback_cycle_responses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON feedback_cycle_responses
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());
