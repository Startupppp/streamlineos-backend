SET lock_timeout = '5s';
--> statement-breakpoint
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        org_id,
        type,
        CASE WHEN membership_id IS NOT NULL THEN 'm:' || membership_id::text ELSE 'u:' || user_id END
      ORDER BY
        CASE status
          WHEN 'completed' THEN 0
          WHEN 'skipped' THEN 1
          WHEN 'in_progress' THEN 2
          WHEN 'not_started' THEN 3
          ELSE 4
        END,
        created_at DESC,
        id DESC
    ) AS rank
  FROM "onboarding_flow_sessions"
  WHERE status <> 'abandoned'
)
UPDATE "onboarding_flow_sessions" AS s
SET status = 'abandoned', updated_at = now()
FROM ranked
WHERE ranked.id = s.id AND ranked.rank > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_onb_flow_sessions_membership_type"
  ON "onboarding_flow_sessions" (org_id, membership_id, type)
  WHERE membership_id IS NOT NULL AND status != 'abandoned';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_onb_flow_sessions_user_type"
  ON "onboarding_flow_sessions" (org_id, user_id, type)
  WHERE membership_id IS NULL AND status != 'abandoned';
