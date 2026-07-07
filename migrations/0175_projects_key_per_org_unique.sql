-- 0175_projects_key_per_org_unique.sql
-- Multi-tenancy fix: project "key" was globally UNIQUE (projects_key_unique), so one org's key
-- (e.g. STRE) blocked every other org from using it. Enforce uniqueness per (org_id, key) instead.
-- Idempotent; additive-safe (existing keys are globally unique so no (org_id,key) collision possible).
-- Renumbered from 0170 (0170-0174 taken by the support batch).

ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_key_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_projects_org_key" ON "projects" ("org_id", "key");
