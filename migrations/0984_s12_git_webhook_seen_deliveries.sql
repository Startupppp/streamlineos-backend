-- S12: Replay protection for inbound git webhooks. GitHub sends x-github-delivery
-- and GitLab sends x-gitlab-event-uuid — both are stable UUIDs that survive retries
-- but differ across deliveries. Recording a seen delivery as (org_id, provider,
-- delivery_id) makes a replay a no-op INSERT ON CONFLICT DO NOTHING rather than
-- re-processing a validly-signed captured payload.
--
-- Retention: rows older than 7 days may be pruned by a maintenance job
-- (DELETE WHERE seen_at < NOW() - INTERVAL '7 days'). GitHub and GitLab retry
-- within minutes to hours; 7 days is well beyond their retry windows.

SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS build.git_webhook_seen_deliveries (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  seen_at TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
ALTER TABLE build.git_webhook_seen_deliveries
  ADD CONSTRAINT "uniq_git_webhook_seen_deliveries_delivery"
  UNIQUE (org_id, provider, delivery_id);
--> statement-breakpoint
CREATE INDEX "idx_git_webhook_seen_deliveries_org_seen_at"
  ON build.git_webhook_seen_deliveries (org_id, seen_at);
