-- Rollback for 1228_kb_health_items
-- Drops the table 1228 created, with its policy, indexes and constraints.
-- Safe in both directions only while nothing writes kb_health_items — which is
-- the state 1228 was authored in (no Drizzle table, no call site). Once a
-- workflow writes assignments and dismissal reasons here, this rollback
-- destroys them: re-detection can recreate an item, but not who it was
-- assigned to or why a human dismissed it. Take a backup of the table before
-- rolling back past that point.
SET lock_timeout = '5s';

DROP POLICY IF EXISTS tenant_isolation ON "public"."kb_health_items";

ALTER TABLE IF EXISTS "public"."kb_health_items" DROP CONSTRAINT IF EXISTS "fk_kb_health_items_org_assignee";

ALTER TABLE IF EXISTS "public"."kb_health_items" DROP CONSTRAINT IF EXISTS "fk_kb_health_items_org_page";

ALTER TABLE IF EXISTS "public"."kb_health_items" DROP CONSTRAINT IF EXISTS "kb_health_items_org_id_organizations_id_fk";

DROP INDEX IF EXISTS "public"."idx_kb_health_items_org_dismissal_expiry";

DROP INDEX IF EXISTS "public"."idx_kb_health_items_org_due";

DROP INDEX IF EXISTS "public"."idx_kb_health_items_org_assignee";

DROP INDEX IF EXISTS "public"."idx_kb_health_items_org_page";

DROP INDEX IF EXISTS "public"."idx_kb_health_items_org_kind_state";

DROP INDEX IF EXISTS "public"."idx_kb_health_items_org_state_impact";

DROP INDEX IF EXISTS "public"."uniq_kb_health_items_active";

DROP TABLE IF EXISTS "public"."kb_health_items";
