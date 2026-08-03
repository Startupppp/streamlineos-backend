SET statement_timeout = 0;
-- 0337 — modules catalog: single lowercase vocabulary enforced by FK
-- =============================================================================
-- Creates the modules_catalog table as the single source of truth for every
-- valid module key. A CHECK constraint enforces the lowercase-only format at
-- the DB layer, and a new FK from org_modules.module_key → modules_catalog
-- makes an unknown or UPPERCASE key a hard constraint violation rather than a
-- silent mis-hit.
--
-- Catalog rows are seeded from the code-level MODULE_CATALOG:
--   core (always-on, no org_modules row needed): kb, chat
--   paid-only (blocked on FREE tier):            payroll, inventory
--   standard gated:                              hr, crm, build, accounting,
--                                                support, surveys, sign
--
-- For populated DBs: existing org_modules rows with legacy UPPERCASE / alias
-- values (e.g. "PROJECTS", "FINANCE", "HELPDESK") are normalised to their
-- canonical lowercase key before the FK is applied. module_setup_checklists
-- rows receive the same normalisation so the onboarding checklist endpoints
-- (which filter by u.enabledModules — already lowercase from listModules) work
-- correctly. Checklist rows for the defunct "PAYMENTS" key are deleted.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "modules_catalog" (
  "module_key"   text        PRIMARY KEY,
  "name"         text        NOT NULL,
  "description"  text,
  "is_core"      boolean     NOT NULL DEFAULT false,
  "is_paid_only" boolean     NOT NULL DEFAULT false,
  "sort_order"   integer     NOT NULL,
  "status"       text        NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT "modules_catalog_key_format" CHECK ("module_key" ~ '^[a-z][a-z0-9_-]*$')
);
--> statement-breakpoint
INSERT INTO "modules_catalog" ("module_key", "name", "is_core", "is_paid_only", "sort_order") VALUES
  ('hr',         'HR',             false, false,  1),
  ('crm',        'CRM',            false, false,  2),
  ('build',      'Build',          false, false,  3),
  ('accounting', 'Accounting',     false, false,  4),
  ('inventory',  'Inventory',      false, true,   5),
  ('kb',         'Knowledge Base', true,  false,  6),
  ('chat',       'Chat',           true,  false,  7),
  ('support',    'Support',        false, false,  8),
  ('surveys',    'Surveys',        false, false,  9),
  ('payroll',    'Payroll',        false, true,  10),
  ('sign',       'Sign',           false, false, 11)
ON CONFLICT ("module_key") DO NOTHING;
--> statement-breakpoint
WITH ranked AS (
  SELECT
    id,
    org_id,
    module_key,
    CASE module_key
      WHEN 'HR'         THEN 'hr'
      WHEN 'CRM'        THEN 'crm'
      WHEN 'BUILD'      THEN 'build'
      WHEN 'PROJECTS'   THEN 'build'
      WHEN 'FINANCE'    THEN 'accounting'
      WHEN 'INVENTORY'  THEN 'inventory'
      WHEN 'HELPDESK'   THEN 'support'
      WHEN 'SURVEYS'    THEN 'surveys'
      WHEN 'PAYROLL'    THEN 'payroll'
      WHEN 'SIGN'       THEN 'sign'
      WHEN 'CHAT'       THEN 'chat'
      WHEN 'KNOWLEDGE'  THEN 'kb'
      ELSE module_key
    END AS canonical_key,
    ROW_NUMBER() OVER (
      PARTITION BY org_id,
        CASE module_key
          WHEN 'HR'         THEN 'hr'
          WHEN 'CRM'        THEN 'crm'
          WHEN 'BUILD'      THEN 'build'
          WHEN 'PROJECTS'   THEN 'build'
          WHEN 'FINANCE'    THEN 'accounting'
          WHEN 'INVENTORY'  THEN 'inventory'
          WHEN 'HELPDESK'   THEN 'support'
          WHEN 'SURVEYS'    THEN 'surveys'
          WHEN 'PAYROLL'    THEN 'payroll'
          WHEN 'SIGN'       THEN 'sign'
          WHEN 'CHAT'       THEN 'chat'
          WHEN 'KNOWLEDGE'  THEN 'kb'
          ELSE module_key
        END
      ORDER BY
        CASE WHEN module_key !~ '[A-Z]' THEN 0 ELSE 1 END,
        enabled DESC,
        enabled_at DESC
    ) AS rn
  FROM "org_modules"
)
DELETE FROM "org_modules"
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint
UPDATE "org_modules"
SET "module_key" = CASE "module_key"
    WHEN 'HR'         THEN 'hr'
    WHEN 'CRM'        THEN 'crm'
    WHEN 'BUILD'      THEN 'build'
    WHEN 'PROJECTS'   THEN 'build'
    WHEN 'FINANCE'    THEN 'accounting'
    WHEN 'INVENTORY'  THEN 'inventory'
    WHEN 'HELPDESK'   THEN 'support'
    WHEN 'SURVEYS'    THEN 'surveys'
    WHEN 'PAYROLL'    THEN 'payroll'
    WHEN 'SIGN'       THEN 'sign'
    WHEN 'CHAT'       THEN 'chat'
    WHEN 'KNOWLEDGE'  THEN 'kb'
  END
WHERE "module_key" IN (
  'HR', 'CRM', 'BUILD', 'PROJECTS', 'FINANCE', 'INVENTORY',
  'HELPDESK', 'SURVEYS', 'PAYROLL', 'SIGN', 'CHAT', 'KNOWLEDGE'
);
--> statement-breakpoint
ALTER TABLE "org_modules" ALTER COLUMN "module_key" TYPE text;
--> statement-breakpoint
DELETE FROM "module_setup_checklists"
WHERE "module_key" NOT IN (
  'hr', 'crm', 'build', 'accounting', 'inventory', 'kb', 'chat', 'support', 'surveys', 'payroll', 'sign',
  'HR', 'CRM', 'BUILD', 'PROJECTS', 'FINANCE', 'INVENTORY', 'HELPDESK', 'SURVEYS', 'PAYROLL', 'SIGN', 'CHAT', 'KNOWLEDGE'
);
--> statement-breakpoint
UPDATE "module_setup_checklists"
SET "module_key" = CASE "module_key"
    WHEN 'HR'         THEN 'hr'
    WHEN 'CRM'        THEN 'crm'
    WHEN 'BUILD'      THEN 'build'
    WHEN 'PROJECTS'   THEN 'build'
    WHEN 'FINANCE'    THEN 'accounting'
    WHEN 'INVENTORY'  THEN 'inventory'
    WHEN 'HELPDESK'   THEN 'support'
    WHEN 'SURVEYS'    THEN 'surveys'
    WHEN 'PAYROLL'    THEN 'payroll'
    WHEN 'SIGN'       THEN 'sign'
    WHEN 'CHAT'       THEN 'chat'
    WHEN 'KNOWLEDGE'  THEN 'kb'
  END
WHERE "module_key" IN (
  'HR', 'CRM', 'BUILD', 'PROJECTS', 'FINANCE', 'INVENTORY',
  'HELPDESK', 'SURVEYS', 'PAYROLL', 'SIGN', 'CHAT', 'KNOWLEDGE'
);
--> statement-breakpoint
ALTER TABLE "org_modules"
  ADD CONSTRAINT "org_modules_module_key_modules_catalog_module_key_fk"
  FOREIGN KEY ("module_key") REFERENCES "modules_catalog" ("module_key");
