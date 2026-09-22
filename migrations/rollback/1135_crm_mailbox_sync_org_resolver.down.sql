SET statement_timeout = 0;
SET lock_timeout = '5s';

-- Reverses 1135. Dropping the resolver restores the pre-1135 behaviour exactly:
-- `POST /crm/mailboxes/push` answers 500 again because the tenant lookup has no way
-- to run without a GUC. Nothing else depends on the function — it is called from one
-- place, `CrmMailboxService.push` — so the drop is complete and carries no data loss.

DROP FUNCTION IF EXISTS app.resolve_crm_mailbox_sync_org_id(text, text);
