-- Rollback for 0423_repair_schema_drift.
--
-- PARTIAL BY DESIGN — two things are deliberately not reverted:
--
--  1. RLS on the nine pre-existing tables (legal_entities, managed_product_releases and
--     the seven inv_* tables) stays ENABLED. Reverting it would restore a cross-tenant
--     read of every org's rows, which is not a state worth being able to return to.
--     The five tables 0423 created are dropped outright, so their policies go with them.
--
--  2. ALTER TYPE ... ADD VALUE cannot be undone in PostgreSQL. 'SUSPENDED' stays in
--     subscription_status. It is additive and unreferenced by data unless something
--     wrote it, so leaving it is harmless.
--
-- Everything else is a clean inverse.

SET lock_timeout = '5s';

DROP TABLE IF EXISTS "crm_contact_consent_events" CASCADE;
DROP TABLE IF EXISTS "crm_contact_channel_consent" CASCADE;
DROP TABLE IF EXISTS "dunning_attempts" CASCADE;
DROP TABLE IF EXISTS "support_ticket_custom_field_values" CASCADE;
DROP TABLE IF EXISTS "ticket_custom_field_values" CASCADE;

DROP TYPE IF EXISTS "public"."crm_consent_channel";
DROP TYPE IF EXISTS "public"."crm_consent_status";
DROP TYPE IF EXISTS "public"."crm_consent_source";
DROP TYPE IF EXISTS "public"."crm_legal_basis";

ALTER TABLE "notification_audit_logs" DROP COLUMN IF EXISTS "last_seen_at";
ALTER TABLE "notification_audit_logs" DROP COLUMN IF EXISTS "updated_at";
ALTER TABLE "bonuses" DROP COLUMN IF EXISTS "amount_cents";
