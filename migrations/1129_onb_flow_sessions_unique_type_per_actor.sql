SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_onb_flow_sessions_org_membership_type";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_onb_flow_sessions_membership_type"
  ON "onboarding_flow_sessions" (org_id, membership_id, type)
  WHERE membership_id IS NOT NULL AND status != 'abandoned';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_onb_flow_sessions_user_type"
  ON "onboarding_flow_sessions" (org_id, user_id, type)
  WHERE membership_id IS NULL AND status != 'abandoned';
