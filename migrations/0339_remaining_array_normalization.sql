SET statement_timeout = 0;
-- 0339 — replace remaining entity-bearing array/JSONB columns with normalized child tables
-- =============================================================================
-- FK arrays with no referential integrity:
--   territories.assigned_reps integer[]
--     → territory_reps (territory_id, crm_person_id, assigned_at)
--       FK crm_person_id → crm_people(id)
--       composite FK (org_id, territory_id) → territories(org_id, id)
--
--   territories.states text[] + territories.cities text[]
--     → territory_locations (territory_id, kind, value)
--       kind ∈ {'STATE','CITY'}
--       composite FK (org_id, territory_id) → territories(org_id, id)
--
--   document_types.applicable_roles text[]
--     → document_type_roles (document_type_id, role_slug)
--       role_slug is an UPPERCASE_SNAKE template slug, NOT a FK to the
--       per-org roles table (those role slugs exist per org; these are
--       cross-org template strings).
--       composite FK (org_id, document_type_id) → document_types(org_id, id)
--
-- JSONB arrays holding lifecycle entities:
--   hr_employee_profiles.education jsonb
--     → hr_employee_education
--       composite FK (org_id, employee_profile_id) → hr_employee_profiles(org_id, id)
--
--   hr_employee_profiles.certifications jsonb
--     → hr_employee_certifications
--       expires_at date column + index for expiry-alerting queries
--       composite FK (org_id, employee_profile_id) → hr_employee_profiles(org_id, id)
--
--   support_ticket_messages.attachments jsonb
--     → support_ticket_attachments
--       support_ticket_messages has no org_id column; org_id is sourced
--       from support_tickets via ticket_id during backfill and insert.
--       Simple FK message_id → support_ticket_messages(id).
--
--   hr_workflow_step_actions.attachments jsonb
--     → hr_workflow_instance_attachments
--       (task listed this as hr_workflow_instances.attachments but the
--        actual column lives on hr_workflow_step_actions)
--       composite FK (org_id, action_id) → hr_workflow_step_actions(org_id, id)
--
-- Columns declined (bounded value lists, not entity collections):
--   terminations.reasons text[]           — bounded termination-reason codes
--   terminations.supporting_doc_urls text[] — bounded list of document URLs
--   document_templates.variables jsonb    — bounded template variable name list
--   onboarding_tasks.depends_on_task_ids jsonb — bounded numeric dependency list
--   resignations.feedback jsonb           — bounded Q&A struct, not an entity
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. territory_reps
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "territory_reps" (
  "id"             serial PRIMARY KEY,
  "org_id"         text    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "territory_id"   integer NOT NULL,
  "crm_person_id"  integer NOT NULL REFERENCES "crm_people"("id") ON DELETE CASCADE,
  "assigned_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_territory_reps_org_id"
    UNIQUE ("org_id", "id"),
  CONSTRAINT "territory_reps_org_territory_fk"
    FOREIGN KEY ("org_id", "territory_id") REFERENCES "territories"("org_id", "id") ON DELETE CASCADE,
  CONSTRAINT "uniq_territory_reps_territory_person"
    UNIQUE ("territory_id", "crm_person_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_territory_reps_org" ON "territory_reps" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_territory_reps_territory" ON "territory_reps" ("territory_id");

--> statement-breakpoint

-- Backfill from territories.assigned_reps.
-- crm_people rows that do not exist are silently skipped via the WHERE NOT EXISTS
-- guard so that referential-integrity violations (integers with no matching
-- crm_people row) do not abort the migration on a populated database.
INSERT INTO "territory_reps" ("org_id", "territory_id", "crm_person_id", "assigned_at")
SELECT t.org_id, t.id, r.rep_id, now()
FROM "territories" t
CROSS JOIN LATERAL unnest(t.assigned_reps) AS r(rep_id)
WHERE t.assigned_reps IS NOT NULL AND cardinality(t.assigned_reps) > 0
  AND EXISTS (SELECT 1 FROM "crm_people" p WHERE p.id = r.rep_id)
ON CONFLICT ("territory_id", "crm_person_id") DO NOTHING;

--> statement-breakpoint
ALTER TABLE "territories" DROP COLUMN IF EXISTS "assigned_reps";

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. territory_locations  (states + cities merged into kind/value rows)
-- ─────────────────────────────────────────────────────────────────────────────
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "territory_locations" (
  "id"           serial PRIMARY KEY,
  "org_id"       text    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "territory_id" integer NOT NULL,
  "kind"         text    NOT NULL,
  "value"        text    NOT NULL,
  CONSTRAINT "territory_locations_org_territory_fk"
    FOREIGN KEY ("org_id", "territory_id") REFERENCES "territories"("org_id", "id") ON DELETE CASCADE,
  CONSTRAINT "uniq_territory_locations_territory_kind_value"
    UNIQUE ("territory_id", "kind", "value")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_territory_locations_org" ON "territory_locations" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_territory_locations_territory" ON "territory_locations" ("territory_id");

--> statement-breakpoint
INSERT INTO "territory_locations" ("org_id", "territory_id", "kind", "value")
SELECT t.org_id, t.id, 'STATE', s.state
FROM "territories" t
CROSS JOIN LATERAL unnest(t.states) AS s(state)
WHERE t.states IS NOT NULL AND cardinality(t.states) > 0
ON CONFLICT ("territory_id", "kind", "value") DO NOTHING;

--> statement-breakpoint
INSERT INTO "territory_locations" ("org_id", "territory_id", "kind", "value")
SELECT t.org_id, t.id, 'CITY', c.city
FROM "territories" t
CROSS JOIN LATERAL unnest(t.cities) AS c(city)
WHERE t.cities IS NOT NULL AND cardinality(t.cities) > 0
ON CONFLICT ("territory_id", "kind", "value") DO NOTHING;

--> statement-breakpoint
ALTER TABLE "territories" DROP COLUMN IF EXISTS "states";
--> statement-breakpoint
ALTER TABLE "territories" DROP COLUMN IF EXISTS "cities";

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. document_type_roles
-- ─────────────────────────────────────────────────────────────────────────────
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_type_roles" (
  "id"               serial PRIMARY KEY,
  "org_id"           text    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "document_type_id" integer NOT NULL,
  "role_slug"        text    NOT NULL,
  CONSTRAINT "uniq_document_type_roles_org_id"
    UNIQUE ("org_id", "id"),
  CONSTRAINT "document_type_roles_org_type_fk"
    FOREIGN KEY ("org_id", "document_type_id") REFERENCES "document_types"("org_id", "id") ON DELETE CASCADE,
  CONSTRAINT "uniq_document_type_roles_type_slug"
    UNIQUE ("document_type_id", "role_slug")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_type_roles_org" ON "document_type_roles" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_type_roles_type" ON "document_type_roles" ("document_type_id");

--> statement-breakpoint
INSERT INTO "document_type_roles" ("org_id", "document_type_id", "role_slug")
SELECT dt.org_id, dt.id, r.role_slug
FROM "document_types" dt
CROSS JOIN LATERAL unnest(dt.applicable_roles) AS r(role_slug)
WHERE dt.applicable_roles IS NOT NULL AND cardinality(dt.applicable_roles) > 0
ON CONFLICT ("document_type_id", "role_slug") DO NOTHING;

--> statement-breakpoint
ALTER TABLE "document_types" DROP COLUMN IF EXISTS "applicable_roles";

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. hr_employee_education
-- ─────────────────────────────────────────────────────────────────────────────
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hr_employee_education" (
  "id"                  serial PRIMARY KEY,
  "org_id"              text    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "employee_profile_id" integer NOT NULL,
  "institution"         text    NOT NULL,
  "degree"              text,
  "field"               text,
  "start_year"          integer,
  "end_year"            integer,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_hr_employee_education_org_id"
    UNIQUE ("org_id", "id"),
  CONSTRAINT "hr_employee_education_org_profile_fk"
    FOREIGN KEY ("org_id", "employee_profile_id") REFERENCES "hr_employee_profiles"("org_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_employee_education_org"
  ON "hr_employee_education" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_employee_education_profile"
  ON "hr_employee_education" ("employee_profile_id");

--> statement-breakpoint
INSERT INTO "hr_employee_education"
  ("org_id", "employee_profile_id", "institution", "degree", "field", "start_year", "end_year", "created_at")
SELECT
  ep.org_id,
  ep.id,
  (elem->>'institution'),
  NULLIF(elem->>'degree', ''),
  NULLIF(elem->>'field', ''),
  CASE WHEN elem->>'startYear' ~ '^\d+$' THEN (elem->>'startYear')::integer END,
  CASE WHEN elem->>'endYear'   ~ '^\d+$' THEN (elem->>'endYear')::integer   END,
  now()
FROM "hr_employee_profiles" ep
CROSS JOIN LATERAL jsonb_array_elements(ep.education) AS elem
WHERE ep.education IS NOT NULL
  AND jsonb_typeof(ep.education) = 'array'
  AND jsonb_array_length(ep.education) > 0
  AND (elem->>'institution') IS NOT NULL AND (elem->>'institution') <> '';

--> statement-breakpoint
ALTER TABLE "hr_employee_profiles" DROP COLUMN IF EXISTS "education";

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. hr_employee_certifications
-- ─────────────────────────────────────────────────────────────────────────────
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hr_employee_certifications" (
  "id"                  serial PRIMARY KEY,
  "org_id"              text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "employee_profile_id" integer NOT NULL,
  "name"                text NOT NULL,
  "issuer"              text,
  "issued_at"           date,
  "expires_at"          date,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_hr_employee_certifications_org_id"
    UNIQUE ("org_id", "id"),
  CONSTRAINT "hr_employee_certifications_org_profile_fk"
    FOREIGN KEY ("org_id", "employee_profile_id") REFERENCES "hr_employee_profiles"("org_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_employee_certifications_org"
  ON "hr_employee_certifications" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_employee_certifications_profile"
  ON "hr_employee_certifications" ("employee_profile_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_employee_certifications_expires_at"
  ON "hr_employee_certifications" ("expires_at")
  WHERE "expires_at" IS NOT NULL;

--> statement-breakpoint
INSERT INTO "hr_employee_certifications"
  ("org_id", "employee_profile_id", "name", "issuer", "issued_at", "expires_at", "created_at")
SELECT
  ep.org_id,
  ep.id,
  (elem->>'name'),
  NULLIF(elem->>'issuer', ''),
  CASE WHEN elem->>'issuedAt'  ~ '^\d{4}-\d{2}-\d{2}' THEN (elem->>'issuedAt')::date  END,
  CASE WHEN elem->>'expiresAt' ~ '^\d{4}-\d{2}-\d{2}' THEN (elem->>'expiresAt')::date END,
  now()
FROM "hr_employee_profiles" ep
CROSS JOIN LATERAL jsonb_array_elements(ep.certifications) AS elem
WHERE ep.certifications IS NOT NULL
  AND jsonb_typeof(ep.certifications) = 'array'
  AND jsonb_array_length(ep.certifications) > 0
  AND (elem->>'name') IS NOT NULL AND (elem->>'name') <> '';

--> statement-breakpoint
ALTER TABLE "hr_employee_profiles" DROP COLUMN IF EXISTS "certifications";

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. support_ticket_attachments
--    support_ticket_messages has no org_id; org_id is sourced from
--    support_tickets via ticket_id.  The FK is a plain message_id → id
--    (no composite variant because support_ticket_messages lacks org_id).
-- ─────────────────────────────────────────────────────────────────────────────
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_ticket_attachments" (
  "id"         serial PRIMARY KEY,
  "org_id"     text    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "message_id" integer NOT NULL REFERENCES "support_ticket_messages"("id") ON DELETE CASCADE,
  "file_name"  text    NOT NULL,
  "file_url"   text    NOT NULL,
  "file_size"  integer,
  "mime_type"  text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_support_ticket_attachments_org_id"
    UNIQUE ("org_id", "id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_ticket_attachments_org"
  ON "support_ticket_attachments" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_ticket_attachments_message"
  ON "support_ticket_attachments" ("message_id");

--> statement-breakpoint
INSERT INTO "support_ticket_attachments"
  ("org_id", "message_id", "file_name", "file_url", "file_size", "mime_type", "created_at")
SELECT
  st.org_id,
  m.id,
  (elem->>'fileName'),
  (elem->>'fileUrl'),
  CASE WHEN (elem->>'fileSize') ~ '^\d+$' THEN (elem->>'fileSize')::integer END,
  NULLIF(elem->>'mimeType', ''),
  now()
FROM "support_ticket_messages" m
JOIN "support_tickets" st ON st.id = m.ticket_id
CROSS JOIN LATERAL jsonb_array_elements(m.attachments) AS elem
WHERE m.attachments IS NOT NULL
  AND jsonb_typeof(m.attachments) = 'array'
  AND jsonb_array_length(m.attachments) > 0
  AND (elem->>'fileName') IS NOT NULL AND (elem->>'fileName') <> ''
  AND (elem->>'fileUrl')  IS NOT NULL AND (elem->>'fileUrl')  <> '';

--> statement-breakpoint
ALTER TABLE "support_ticket_messages" DROP COLUMN IF EXISTS "attachments";

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. hr_workflow_instance_attachments
--    (column lives on hr_workflow_step_actions, named for the parent instance)
-- ─────────────────────────────────────────────────────────────────────────────
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hr_workflow_instance_attachments" (
  "id"         serial PRIMARY KEY,
  "org_id"     text    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "action_id"  integer NOT NULL,
  "url"        text    NOT NULL,
  "name"       text    NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_hr_wf_inst_attachments_org_id"
    UNIQUE ("org_id", "id"),
  CONSTRAINT "hr_wf_inst_attachments_org_action_fk"
    FOREIGN KEY ("org_id", "action_id") REFERENCES "hr_workflow_step_actions"("org_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_wf_inst_attachments_org"
  ON "hr_workflow_instance_attachments" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_wf_inst_attachments_action"
  ON "hr_workflow_instance_attachments" ("action_id");

--> statement-breakpoint
INSERT INTO "hr_workflow_instance_attachments"
  ("org_id", "action_id", "url", "name", "created_at")
SELECT
  a.org_id,
  a.id,
  (elem->>'url'),
  (elem->>'name'),
  now()
FROM "hr_workflow_step_actions" a
CROSS JOIN LATERAL jsonb_array_elements(a.attachments) AS elem
WHERE a.attachments IS NOT NULL
  AND jsonb_typeof(a.attachments) = 'array'
  AND jsonb_array_length(a.attachments) > 0
  AND (elem->>'url')  IS NOT NULL AND (elem->>'url')  <> ''
  AND (elem->>'name') IS NOT NULL AND (elem->>'name') <> '';

--> statement-breakpoint
ALTER TABLE "hr_workflow_step_actions" DROP COLUMN IF EXISTS "attachments";
