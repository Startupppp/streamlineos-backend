-- Custom SQL migration file, put your code below! --

-- The four legacy association columns become three Party links.
--
-- The half of 0265 that has to be right exactly once, and the same shape as
-- 0264: every statement is an UPDATE guarded by `IS DISTINCT FROM`, joined
-- through the `*_party_map` tables rather than matched on a name, and re-running
-- it changes nothing.
--
-- Every join carries the tenant explicitly even where the map's own composite
-- foreign key already implies it. These are three-table joins between two id
-- spaces, and an `organization_id` that is implied rather than written is how a
-- backfill points one tenant's client at another tenant's lead -- once, silently,
-- and permanently.
--
-- `<> p.party_id` on both party-to-party links, because the CHECKs from 0265
-- would abort the whole migration on a self-reference rather than skip the row.
-- A self-reference is possible here: a merge re-points the losing record's map
-- row onto the survivor, so after one, a single party can answer to a client id
-- AND to the lead id that client was converted from -- which is precisely the
-- pair 0241 named as merge candidates. The link is dropped rather than stored,
-- because "converted from itself" is not a fact.
--
-- The `deals` half is filtered through an EXISTS and the other three are not.
-- `contacts.deal_id` is the one legacy column with no foreign key behind it at
-- all -- 0265 gives Party the constraint `contacts` never had -- so the stored
-- value may name a deal that was deleted or that belongs to another tenant, and
-- copying it across would fail the foreign key and take the migration with it.
-- Rows whose `deal_id` does not resolve are left null: a dangling association is
-- not an association, and Party is not the place to preserve one.
--
-- Legacy columns are NOT cleared. They stay as the mirror of these links, written
-- from here on by `party-legacy-associations.ts`, exactly as 0264 left
-- `contacts.organization_id` in place as the mirror of `employer_party_id`.
-- Ticket 08 drops them with the tables.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

--
-- WHY EVERY STATEMENT BELOW IS GUARDED
--
-- This file was written before ticket 08 dropped `leads`, `clients`, `contacts`
-- and `crm_organizations`, and it was never added to `_journal.json` -- so it
-- did not run while those tables still existed, and it is ordered after 0278
-- now that it has been. Read literally it would fail on `relation "clients" does
-- not exist`, which is what it did the moment it was journalled.
--
-- Each UPDATE is wrapped in a `to_regclass` check on the legacy table it reads.
-- On a database that has already dropped them there is nothing to copy and the
-- statement is skipped; on one that somehow still has them the backfill runs
-- exactly as written. A backfill whose source is gone is a no-op, not an error.
--
-- The four statements remain idempotent either way: every one is guarded by
-- `IS DISTINCT FROM` and re-running the file changes nothing.

SET lock_timeout = '5s';

--> statement-breakpoint
/*
 * `clients.lead_id`: the lead a client was converted out of, as the lead's party.
 */
DO $guard$
BEGIN
  IF to_regclass('public.clients') IS NOT NULL THEN
    EXECUTE $stmt$
UPDATE "business_parties" p
SET "converted_from_party_id" = lm."party_id"
FROM "client_party_map" cm
JOIN "clients" c
  ON c."org_id" = cm."organization_id" AND c."id" = cm."client_id"
JOIN "lead_party_map" lm
  ON lm."organization_id" = c."org_id" AND lm."lead_id" = c."lead_id"
WHERE cm."organization_id" = p."organization_id"
  AND cm."party_id" = p."party_id"
  AND c."lead_id" IS NOT NULL
  AND lm."party_id" <> p."party_id"
  AND p."converted_from_party_id" IS DISTINCT FROM lm."party_id";
$stmt$;
  END IF;
END $guard$;

--> statement-breakpoint
/*
 * `contacts.lead_id`: the lead a contact was raised against, as the lead's party.
 *
 * The same relation as the statement above and the same column, which is the
 * decision 0265 records: one link, not two named after whichever table happened
 * to spell it first.
 */
DO $guard$
BEGIN
  IF to_regclass('public.contacts') IS NOT NULL THEN
    EXECUTE $stmt$
UPDATE "business_parties" p
SET "converted_from_party_id" = lm."party_id"
FROM "contact_party_map" cm
JOIN "contacts" ct
  ON ct."org_id" = cm."organization_id" AND ct."id" = cm."contact_id"
JOIN "lead_party_map" lm
  ON lm."organization_id" = ct."org_id" AND lm."lead_id" = ct."lead_id"
WHERE cm."organization_id" = p."organization_id"
  AND cm."party_id" = p."party_id"
  AND ct."lead_id" IS NOT NULL
  AND lm."party_id" <> p."party_id"
  AND p."converted_from_party_id" IS DISTINCT FROM lm."party_id";
$stmt$;
  END IF;
END $guard$;

--> statement-breakpoint
/*
 * `contacts.deal_id`: the deal a person is attached to.
 *
 * The EXISTS is load-bearing; see the header. `deleted_at IS NULL` is
 * deliberately NOT part of it -- a soft-deleted deal is still a row, the legacy
 * column still names it, and dropping the link here would be this backfill
 * deciding something the association never said.
 */
DO $guard$
BEGIN
  IF to_regclass('public.contacts') IS NOT NULL THEN
    EXECUTE $stmt$
UPDATE "business_parties" p
SET "primary_deal_id" = ct."deal_id"
FROM "contact_party_map" cm
JOIN "contacts" ct
  ON ct."org_id" = cm."organization_id" AND ct."id" = cm."contact_id"
WHERE cm."organization_id" = p."organization_id"
  AND cm."party_id" = p."party_id"
  AND ct."deal_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "deals" d
    WHERE d."org_id" = ct."org_id" AND d."id" = ct."deal_id"
  )
  AND p."primary_deal_id" IS DISTINCT FROM ct."deal_id";
$stmt$;
  END IF;
END $guard$;

--> statement-breakpoint
/*
 * `crm_organizations.parent_id`: the account hierarchy, as parties.
 *
 * Both ends go through `crm_org_party_map` -- the child to find the party being
 * updated, the parent to find the party it points at -- which is why the map
 * appears twice. A parent with no party is left null rather than invented: 0264
 * gave every `crm_organizations` row a party, so the only way to land here is a
 * `parent_id` pointing at a row that no longer exists, and that is a dangling
 * pointer rather than a hierarchy.
 */
DO $guard$
BEGIN
  IF to_regclass('public.crm_organizations') IS NOT NULL THEN
    EXECUTE $stmt$
UPDATE "business_parties" p
SET "parent_party_id" = pm."party_id"
FROM "crm_org_party_map" cm
JOIN "crm_organizations" o
  ON o."org_id" = cm."organization_id" AND o."id" = cm."crm_organization_id"
JOIN "crm_org_party_map" pm
  ON pm."organization_id" = o."org_id" AND pm."crm_organization_id" = o."parent_id"
WHERE cm."organization_id" = p."organization_id"
  AND cm."party_id" = p."party_id"
  AND o."parent_id" IS NOT NULL
  AND pm."party_id" <> p."party_id"
  AND p."parent_party_id" IS DISTINCT FROM pm."party_id";
$stmt$;
  END IF;
END $guard$;

--> statement-breakpoint
ANALYZE "business_parties";
