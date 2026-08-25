-- Custom SQL migration file, put your code below! --

-- One Party per legacy record, and a map row for every one of them.
--
-- The resolver in `party-legacy-seam.ts` is only useful if it is *total*: a
-- consumer moving off `leads` must not have to handle "this lead has no Party"
-- as a case, because that case has no correct behaviour. This migration is what
-- makes the totality true for rows that already exist.
--
-- One Party per legacy *row*, deliberately, not one per distinct person. A
-- client converted from a lead becomes two parties here, and a contact for the
-- same human becomes a third. Collapsing them is a merge decision -- reversible,
-- snapshotted, attributable -- and Phase 1 already has exactly one mechanism for
-- that in `party_merges`. Re-implementing it in SQL, with no snapshot and no way
-- back, is how a backfill silently destroys a customer record. `clients.lead_id`
-- and `contacts.lead_id` still say which rows are candidates; feeding them to
-- PartyMergeService is a follow-up, not this.
--
-- Party ids are derived from the legacy identity rather than random, so that a
-- run interrupted between the two inserts below resumes to the same ids instead
-- of creating a second Party for the same lead. Party ids are not secrets --
-- every read re-asserts organization_id and RLS does it again -- so deriving
-- them costs nothing that was being relied on.
--
-- Idempotent: re-running inserts nothing. Safe on populated tables: every
-- statement is an INSERT with an anti-join or ON CONFLICT DO NOTHING, and no
-- existing row is read as truth or written.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "business_parties" (
  "party_id", "organization_id", "party_type", "name", "email", "phone", "website",
  "status", "notes", "custom_fields",
  "job_title", "company_name", "whatsapp_phone", "city",
  "lifecycle_stage", "priority", "qualification_score", "converted_at", "lost_reason",
  "sla_due_at", "next_follow_up_at", "follow_up_notes",
  "acquisition_source", "acquisition_sub_source", "acquisition_campaign_id",
  "acquisition_context", "referred_by",
  "owner_user_id", "assigned_by_user_id", "assigned_at", "verified_by_user_id",
  "stated_budget", "expected_value",
  "tags", "deleted_at", "created_at", "updated_at"
)
SELECT
  md5('lead:' || l."org_id" || ':' || l."id")::uuid::text,
  l."org_id",
  'CUSTOMER'::"party_type",
  l."name",
  l."email",
  l."phone",
  l."website",
  -- The record is live; where it sits in the pipeline is `lifecycle_stage`.
  'active',
  l."notes",
  l."custom_data",
  l."designation",
  l."company",
  l."whatsapp_number",
  l."city",
  l."status",
  l."priority",
  l."score",
  l."converted_at",
  l."lost_reason",
  l."sla_deadline",
  l."follow_up_date",
  l."follow_up_notes",
  l."source",
  l."sub_source",
  l."campaign_id",
  NULLIF(jsonb_strip_nulls(jsonb_build_object(
    'utmSource',   l."utm_source",
    'utmMedium',   l."utm_medium",
    'utmCampaign', l."utm_campaign",
    'utmContent',  l."utm_content",
    'utmTerm',     l."utm_term",
    'ipAddress',   l."ip_address",
    'referrerUrl', l."referrer_url"
  )), '{}'::jsonb),
  l."referred_by",
  l."assigned_to_id",
  l."assigned_by_id",
  l."assigned_at",
  l."verified_by_id",
  l."investment_interest",
  l."potential_value",
  COALESCE(l."tags", '{}'::text[]),
  l."deleted_at",
  -- Carried, not defaulted to now(): `chooseSurvivor` keeps the older record on a
  -- merge, and a backfill that stamped every party with today's date would make
  -- that choice arbitrary.
  l."created_at",
  l."updated_at"
FROM "leads" l
WHERE NOT EXISTS (
  SELECT 1 FROM "lead_party_map" m
  WHERE m."organization_id" = l."org_id" AND m."lead_id" = l."id"
)
ON CONFLICT ("party_id") DO NOTHING;

--> statement-breakpoint
INSERT INTO "lead_party_map" ("organization_id", "lead_id", "party_id", "linked_by")
SELECT l."org_id", l."id", md5('lead:' || l."org_id" || ':' || l."id")::uuid::text, 'migration:0241'
FROM "leads" l
WHERE EXISTS (
  SELECT 1 FROM "business_parties" p
  WHERE p."party_id" = md5('lead:' || l."org_id" || ':' || l."id")::uuid::text
)
ON CONFLICT ("organization_id", "lead_id") DO NOTHING;

--> statement-breakpoint
INSERT INTO "business_parties" (
  "party_id", "organization_id", "party_type", "name", "email", "phone",
  "status", "notes", "tax_number",
  "job_title", "company_name", "city", "state",
  "lifecycle_stage", "converted_at",
  "owner_user_id", "lifetime_value",
  "health_score", "health_status", "health_checked_at",
  "churn_risk_score", "churn_risk_reasoning",
  "created_at", "updated_at"
)
SELECT
  md5('client:' || c."org_id" || ':' || c."id")::uuid::text,
  c."org_id",
  -- `is_vendor` is not a column here. Phase 1 models "this company is both a
  -- customer and a supplier" as two rows in `party_roles`, precisely so that it
  -- does not force a second record for the same business; the role is inserted
  -- below and the type records the same fact where the enum can express it.
  CASE WHEN c."is_vendor" THEN 'BOTH'::"party_type" ELSE 'CUSTOMER'::"party_type" END,
  c."name",
  c."email",
  c."phone",
  c."status",
  c."notes",
  -- `gstin` is a tax number, and Party already had the column for it.
  c."gstin",
  c."designation",
  c."company",
  c."city",
  c."state",
  'CUSTOMER',
  c."converted_at",
  c."account_manager_id",
  c."investment_value",
  c."health_score",
  c."health_status",
  c."last_health_check",
  c."churn_risk_score",
  c."churn_risk_reasoning",
  c."created_at",
  c."updated_at"
FROM "clients" c
WHERE NOT EXISTS (
  SELECT 1 FROM "client_party_map" m
  WHERE m."organization_id" = c."org_id" AND m."client_id" = c."id"
)
ON CONFLICT ("party_id") DO NOTHING;

--> statement-breakpoint
INSERT INTO "client_party_map" ("organization_id", "client_id", "party_id", "linked_by")
SELECT c."org_id", c."id", md5('client:' || c."org_id" || ':' || c."id")::uuid::text, 'migration:0241'
FROM "clients" c
WHERE EXISTS (
  SELECT 1 FROM "business_parties" p
  WHERE p."party_id" = md5('client:' || c."org_id" || ':' || c."id")::uuid::text
)
ON CONFLICT ("organization_id", "client_id") DO NOTHING;

--> statement-breakpoint
INSERT INTO "business_parties" (
  "party_id", "organization_id", "party_type", "name", "email", "phone", "website",
  "status", "job_title", "department", "company_name",
  "avatar_url", "linkedin_url", "social_profiles",
  "tags", "deleted_at", "created_at", "updated_at"
)
SELECT
  md5('contact:' || ct."org_id" || ':' || ct."id")::uuid::text,
  ct."org_id",
  'CUSTOMER'::"party_type",
  ct."name",
  ct."email",
  ct."phone",
  ct."website_url",
  'active',
  ct."title",
  ct."department",
  -- `contacts.organization_id` points at `crm_organizations` and has no home on
  -- Party: an employer should be another party, and nothing gives
  -- `crm_organizations` parties to point at yet. The structured link stays on the
  -- legacy row, which this migration does not touch, and only the free text is
  -- carried across.
  ct."company",
  ct."avatar_url",
  ct."linkedin_url",
  NULLIF(jsonb_strip_nulls(jsonb_build_object('twitter', ct."twitter_url")), '{}'::jsonb),
  -- Guarded rather than assumed to be an array: this column is jsonb, so nothing
  -- in the database has ever enforced that, and one malformed row would take the
  -- whole backfill down.
  CASE WHEN jsonb_typeof(ct."tags") = 'array'
       THEN ARRAY(SELECT jsonb_array_elements_text(ct."tags"))
       ELSE '{}'::text[] END,
  ct."deleted_at",
  ct."created_at",
  ct."updated_at"
FROM "contacts" ct
WHERE NOT EXISTS (
  SELECT 1 FROM "contact_party_map" m
  WHERE m."organization_id" = ct."org_id" AND m."contact_id" = ct."id"
)
ON CONFLICT ("party_id") DO NOTHING;

--> statement-breakpoint
INSERT INTO "contact_party_map" ("organization_id", "contact_id", "party_id", "linked_by")
SELECT ct."org_id", ct."id", md5('contact:' || ct."org_id" || ':' || ct."id")::uuid::text, 'migration:0241'
FROM "contacts" ct
WHERE EXISTS (
  SELECT 1 FROM "business_parties" p
  WHERE p."party_id" = md5('contact:' || ct."org_id" || ':' || ct."id")::uuid::text
)
ON CONFLICT ("organization_id", "contact_id") DO NOTHING;

--> statement-breakpoint
/*
 * What each party is to the organisation.
 *
 * Read off the map rather than the legacy table so that a party which has
 * already absorbed a merge keeps the roles of everything merged into it. Role
 * ids are derived from (org, party, role) for the same reason party ids are:
 * a resumed run must not create a second row.
 */
INSERT INTO "party_roles" ("party_role_id", "organization_id", "party_id", "role", "assigned_by")
SELECT
  md5('party_role:' || m."organization_id" || ':' || m."party_id" || ':PROSPECT')::uuid::text,
  m."organization_id", m."party_id", 'PROSPECT', 'migration:0241'
FROM "lead_party_map" m
ON CONFLICT ("organization_id", "party_id", "role") DO NOTHING;

--> statement-breakpoint
INSERT INTO "party_roles" ("party_role_id", "organization_id", "party_id", "role", "assigned_by")
SELECT
  md5('party_role:' || m."organization_id" || ':' || m."party_id" || ':CUSTOMER')::uuid::text,
  m."organization_id", m."party_id", 'CUSTOMER', 'migration:0241'
FROM "client_party_map" m
ON CONFLICT ("organization_id", "party_id", "role") DO NOTHING;

--> statement-breakpoint
INSERT INTO "party_roles" ("party_role_id", "organization_id", "party_id", "role", "assigned_by")
SELECT
  md5('party_role:' || m."organization_id" || ':' || m."party_id" || ':VENDOR')::uuid::text,
  m."organization_id", m."party_id", 'VENDOR', 'migration:0241'
FROM "client_party_map" m
JOIN "clients" c ON c."org_id" = m."organization_id" AND c."id" = m."client_id"
WHERE c."is_vendor"
ON CONFLICT ("organization_id", "party_id", "role") DO NOTHING;

--> statement-breakpoint
/*
 * A contact is a person at a company, and the merged model will eventually hang
 * it off a company party as a `party_contacts` row. It gets its own party here
 * because the resolver's contract is `-> partyId`, and because a contact with no
 * company has nothing to hang off. The role says which of these came from where.
 */
INSERT INTO "party_roles" ("party_role_id", "organization_id", "party_id", "role", "assigned_by")
SELECT
  md5('party_role:' || m."organization_id" || ':' || m."party_id" || ':CONTACT')::uuid::text,
  m."organization_id", m."party_id", 'CONTACT', 'migration:0241'
FROM "contact_party_map" m
ON CONFLICT ("organization_id", "party_id", "role") DO NOTHING;

--> statement-breakpoint
ANALYZE "business_parties";
--> statement-breakpoint
ANALYZE "lead_party_map";
--> statement-breakpoint
ANALYZE "client_party_map";
--> statement-breakpoint
ANALYZE "contact_party_map";
