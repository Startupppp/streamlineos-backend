-- Custom SQL migration file, put your code below! --

-- One Party per company, and a person's employer becomes another party.
--
-- The half of ticket 25 that has to be right exactly once. `crm_organizations`
-- holds ZERO rows in development and of the single `contacts` row NONE carries an
-- `organization_id`, so this backfill is near-trivial to get right today and will
-- not be once a tenant has used the feature. That timing is the reason the ticket
-- was pulled into this phase rather than left for the contract step.
--
-- Party ids are derived from the legacy identity rather than random, following
-- 0241: a run interrupted between the two inserts below resumes to the same ids
-- instead of creating a second Party for the same company. Party ids are not
-- secrets -- every read re-asserts `organization_id` and RLS does it again -- so
-- deriving them costs nothing that was being relied on.
--
-- One Party per `crm_organizations` ROW, including the rows a previous merge
-- soft-deleted and pointed at a survivor through `merged_into_id`. Collapsing
-- those here would be a merge, and this phase has exactly one merge mechanism:
-- `party_merges`, snapshotted, attributable and reversible. Re-implementing it in
-- SQL with no snapshot and no way back is how a backfill silently destroys a
-- customer record. The historical `merged_into_id` values stay on the legacy rows
-- as evidence and are not replayed -- exactly what 0241 decided for
-- `leads.merged_into_id` and `contacts.merged_into_id`.
--
-- No `party_roles` row, where 0241 granted PROSPECT, CUSTOMER and CONTACT. A role
-- says what a party is TO US, and a company record says no such thing: it is a
-- company that exists, not a relationship we have with it. CUSTOMER arrives with
-- a deal or an invoice, from whichever module records that. Granting one here
-- would put every company anybody has ever typed into the customer list.
--
-- Idempotent: re-running inserts nothing. Safe on populated tables: every
-- statement is an INSERT with an anti-join or ON CONFLICT DO NOTHING, or an
-- UPDATE guarded by IS DISTINCT FROM, and no existing row is read as truth.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "business_parties" (
  "party_id", "organization_id", "party_type", "party_kind", "name",
  "domain", "industry", "company_size", "website", "linkedin_url", "description",
  "health_score", "notes", "status",
  "deleted_at", "created_at", "updated_at"
)
SELECT
  md5('crm_org:' || o."org_id" || ':' || o."id")::uuid::text,
  o."org_id",
  -- The column is NOT NULL DEFAULT 'CUSTOMER' and this is the only value it can
  -- take without asserting a relationship the company record does not record.
  -- The honest statement of "we have no relationship on file yet" is the empty
  -- `party_roles` set above, not a value in this column.
  'CUSTOMER'::"party_type",
  'ORGANISATION'::"party_kind",
  o."name",
  o."domain",
  o."industry",
  o."size",
  o."website",
  o."linkedin_url",
  o."description",
  o."health_score",
  o."notes",
  -- The record is live or it is not; `deleted_at` below carries the deletion.
  'active',
  o."deleted_at",
  -- Carried, not defaulted to now(): `chooseSurvivor` keeps the older record on a
  -- merge, and a backfill that stamped every party with today's date would make
  -- that choice arbitrary.
  o."created_at",
  o."updated_at"
FROM "crm_organizations" o
WHERE NOT EXISTS (
  SELECT 1 FROM "crm_org_party_map" m
  WHERE m."organization_id" = o."org_id" AND m."crm_organization_id" = o."id"
)
ON CONFLICT ("party_id") DO NOTHING;

--> statement-breakpoint
INSERT INTO "crm_org_party_map" ("organization_id", "crm_organization_id", "party_id", "linked_by")
SELECT o."org_id", o."id", md5('crm_org:' || o."org_id" || ':' || o."id")::uuid::text, 'migration:0264'
FROM "crm_organizations" o
WHERE EXISTS (
  SELECT 1 FROM "business_parties" p
  WHERE p."party_id" = md5('crm_org:' || o."org_id" || ':' || o."id")::uuid::text
)
ON CONFLICT ("organization_id", "crm_organization_id") DO NOTHING;

--> statement-breakpoint
/*
 * A party's employer is another party.
 *
 * This is the line the whole ticket exists for. `contacts.organization_id` was a
 * foreign key to `crm_organizations` and there was nothing on Party for it to
 * point at, so every migrate batch left the column behind as "association-only"
 * and `contacts` could not be dropped. Now there is.
 *
 * The legacy column is NOT cleared. It stays as the mirror of this link, written
 * from here on by `party-legacy-employer.ts`, and it is what
 * `PartyDivergenceService.findEmployerDisagreements` compares against. Ticket 08
 * drops it with the table.
 */
UPDATE "business_parties" p
SET "employer_party_id" = m."party_id"
FROM "contact_party_map" cm
JOIN "contacts" ct
  ON ct."org_id" = cm."organization_id" AND ct."id" = cm."contact_id"
JOIN "crm_org_party_map" m
  ON m."organization_id" = ct."org_id" AND m."crm_organization_id" = ct."organization_id"
WHERE cm."organization_id" = p."organization_id"
  AND cm."party_id" = p."party_id"
  AND ct."organization_id" IS NOT NULL
  -- Never point a party at itself; the CHECK from 0262 would reject it anyway,
  -- and a company that is also somebody's contact row is not impossible.
  AND m."party_id" <> p."party_id"
  AND p."employer_party_id" IS DISTINCT FROM m."party_id";

--> statement-breakpoint
ANALYZE "business_parties";
--> statement-breakpoint
ANALYZE "crm_org_party_map";
