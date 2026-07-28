SET statement_timeout = 0;
-- 0340 — module-scoped roles and rank ladder
-- =============================================================================
-- 1. roles gains:
--    module_key text NULL   — NULL = org-wide; non-null = scoped to one module
--    rank       integer NOT NULL DEFAULT 40 (FUNCTIONAL)
--    index on (org_id, module_key) for module-admin lookups
--
-- 2. permissions gains descriptor columns for the grantability engine:
--    module_key   text    — module that owns this permission (null = cross-cutting)
--    risk_class   text    — LOW | MEDIUM | HIGH | CRITICAL
--    is_delegable boolean NOT NULL DEFAULT true
--
-- 3. permission_supported_scopes — child table listing which DataScope values
--    a given permission supports.  PK (permission_key, scope) replaces the
--    former array-column anti-pattern.  Uses the existing data_scope enum.
--
-- DB is EMPTY — no backfill needed.
-- =============================================================================

ALTER TABLE "roles"
  ADD COLUMN "module_key" text,
  ADD COLUMN "rank" integer NOT NULL DEFAULT 40;
--> statement-breakpoint

CREATE INDEX "idx_roles_org_module" ON "roles" ("org_id", "module_key");
--> statement-breakpoint

ALTER TABLE "permissions"
  ADD COLUMN "module_key" text,
  ADD COLUMN "risk_class" text,
  ADD COLUMN "is_delegable" boolean NOT NULL DEFAULT true;
--> statement-breakpoint

CREATE TABLE "permission_supported_scopes" (
  "permission_key" text NOT NULL
    REFERENCES "permissions"("name") ON DELETE CASCADE,
  "scope" data_scope NOT NULL,
  CONSTRAINT "permission_supported_scopes_pkey"
    PRIMARY KEY ("permission_key", "scope")
);
