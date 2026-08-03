-- wave-9-email-outbox-orgid.sql  (Cluster B — email outbox org-scoping)
-- Additive nullable organization_id on email_outbox + index for org-scoped
-- retry/observability. NOT NULL deferred (per plan Phase 2.4). Idempotent.
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS organization_id text;
CREATE INDEX IF NOT EXISTS email_outbox_org_idx ON email_outbox (organization_id, status);
