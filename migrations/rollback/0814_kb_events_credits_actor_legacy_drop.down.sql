-- Rollback for 0814_kb_events_credits_actor_legacy_drop
--
-- IRRECOVERABLE DATA LOSS WARNING:
-- Migration 0814 dropped actor_id (users.id FK) from kb_events and
-- tenant_ai_credit_transactions after the companion actor_membership_id
-- columns were fully backfilled. The original user-id values are permanently
-- gone without a point-in-time restore. This rollback recreates the columns
-- as nullable text so the schema matches the pre-0814 shape. The FK
-- constraints that were dropped along with the columns are NOT recreated
-- here — apply a separate VALIDATE migration if referential integrity is
-- required on the restored column.

SET lock_timeout = '5s';

-- kb_events: restore actor_id as nullable text
ALTER TABLE kb_events
  ADD COLUMN IF NOT EXISTS actor_id text;

-- tenant_ai_credit_transactions: restore actor_id as nullable text
ALTER TABLE tenant_ai_credit_transactions
  ADD COLUMN IF NOT EXISTS actor_id text;
