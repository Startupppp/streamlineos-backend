-- 1097 — Build's CRM keys point at the party maps, not at the legacy tables
-- =============================================================================
-- 1096 did this for CRM's own tables and stopped at the fence: "build.tickets,
-- build.feedback_posts and build.feedbucket_submissions … carry the same
-- defect, but PMS/Build is owned elsewhere." This is those three, and nothing
-- else. It is SQL-only by necessity — `src/db/schema/build/` may not be edited
-- here, so the Drizzle declaration keeps saying `clients` and the catalogue
-- stops agreeing with it. That divergence is deliberate and is carried as an
-- allowlist entry in the declaration/constraint drift gate, not repaired here.
--
-- The defect, restated. `contacts`, `clients` and `crm_organizations` stopped
-- being written: 0277 (ticket 08) detached their sequences and pointed each
-- `*_party_map` column's DEFAULT at them, and ticket 25 did the same for
-- `crm_organizations` via `crm_org_party_map`. A contact or a company created
-- today is a `business_parties` row plus a map row, and no legacy row is ever
-- inserted. 1093 dropped the keys tying each map back to its legacy table,
-- because the map could not satisfy them. The keys pointing INTO the legacy
-- tables from Build stayed, and each one refuses the id of anything created
-- since. Measured on a database built from this branch: setting a ticket's
-- Customer, or a feedback post's or a Feedbucket submission's CRM contact or
-- company, failed with SQLSTATE 23503 and the request returned 500.
--
-- ---------------------------------------------------------------------------
-- The thing a reader will trip over: build.tickets.customer_id had TWO keys,
-- and they disagreed about what the column holds.
--
--   fk_tickets_customer         (customer_id)         -> clients(id)            ON DELETE SET NULL
--   fk_tickets_customer_id_org  (org_id, customer_id) -> crm_organizations(org_id, id)
--
-- A row had to satisfy both, which needs the same integer to be a live
-- `clients.id` AND a live `crm_organizations.id` in that tenant. The two ids
-- come from two independent sequences, so that held only by coincidence. The
-- column is not ambiguous, though — only its history is. It is a
-- `crm_organizations.id`:
--
--   * it was born one. 0006, the migration that adds the column, is
--     `ADD COLUMN "customer_id" integer REFERENCES "crm_organizations"("id")
--     ON DELETE SET NULL` under the heading "ticket<->customer link";
--   * the only writer is the Build ticket sidebar's Customer picker, which
--     lists `GET /crm/organizations` and stores the chosen `org.id`
--     (frontend features/build/ticket-details/ticket-customer-picker.tsx).
--     `createTicketSchema` cannot set it at all; the only route that can is the
--     update, which passes it through unvalidated;
--   * the only reader that resolves it is CRM's company list, which joins
--     `tickets.customer_id` to `crm_org_party_map.crm_organization_id` to count
--     each company's open requests (src/modules/crm/core/lib/crm-org-listing.ts);
--   * `crm-organizations.service.ts` and `crm-customer360.service.ts` both name
--     `tickets.customer_id` in prose as a holder of the `crm_organizations`
--     integer id, as does 0263, the migration that creates the map.
--
-- Nothing reads or writes it as a `clients.id`. So where did the `clients` key
-- come from? 0327 deliberately dropped the original `crm_organizations` key —
-- "tickets.customer_id no longer hard-FKs into crm_organizations … becomes a
-- soft reference resolved at the service layer" — and 0347 B-8 then added
-- `fk_tickets_customer` against `clients` by hand, in a batch of unrelated FK
-- repairs, long before ticket 25 converged `crm_organizations` onto Party. The
-- Drizzle declaration copies 0347, not 0006.
--
-- Neither key is in production. 0619, the snapshot of what production actually
-- has, carries only the two `*_party_id` keys and NEITHER legacy key. 0620, a
-- generated chain-repair, is what re-added both at once — reinstating the key
-- 0327 had removed on purpose alongside the one 0347 had added by mistake, and
-- so manufacturing the contradiction. It exists only on chain-built databases.
--
-- The two backfills split the same way and are the fossil of the confusion:
-- 0272a filled `customer_party_id` from `client_party_map`, 0275a filled
-- `customer_org_party_id` from `crm_org_party_map`, from the one column. 0275a
-- says so outright — "it genuinely points at two tables". Both BEFORE triggers
-- are still installed and both are harmless: `derive_party_from_legacy` returns
-- the row unchanged when the map has no match, so `customer_party_id` simply
-- stops being filled. It is not dropped here; that column belongs to Build.
--
-- So `fk_tickets_customer` is RETIRED rather than repointed. Repointing it at
-- `client_party_map` and leaving it beside the company key would have been the
-- cautious-looking move and would have preserved the bug exactly: the two keys
-- are mutually exclusive on one column, so keeping both keeps every Customer
-- write failing. One column, one meaning, one key.
-- ---------------------------------------------------------------------------
--
-- Each key moves to its map, composite on the tenant, and keeps the delete
-- action its single-column key had — SET NULL throughout, in Postgres 15's
-- column-list form so a delete clears the pointer and never `org_id`. The map
-- row stands in for the legacy row, so deleting it (a party's DPDP erasure
-- cascades to its maps) does what deleting the legacy row did. For
-- `customer_id` that is `fk_tickets_customer`'s SET NULL, which is also the
-- only sound choice: the composite key's bare NO ACTION would have made a
-- ticket block the erasure of the company it names.
--
-- Left alone:
--   * `build.roadmap_items`, which carries `crm_contact_id` and
--     `crm_organization_id` too but has no foreign key on either — nothing to
--     repoint. Checked against pg_constraint, not assumed.
--   * the `*_party_id` columns and their keys into `business_parties`. They are
--     correct already and are what the contract migration will keep.
--   * the legacy tables themselves. On this branch 0278 runs only under
--     `app.allow_legacy_identity_drop`; when it does run, its loop drops only
--     keys whose target is a legacy table, so the keys below survive it.
--
-- No backfill. A row that satisfied the old key names a legacy id, and the map
-- carries exactly those ids — the maps were backfilled from the legacy tables
-- (0241, 0264) before the tables stopped being written, so every legacy id that
-- ever existed has a map row. The pre-check below proves that per-row rather
-- than asserting it: it refuses before any DDL if a row names an id its map
-- does not hold. Validating would fail on such a row anyway, with a worse
-- message.
--
-- Every ADD follows a DROP IF EXISTS, and is added NOT VALID and then
-- validated, so a re-run is a no-op.

SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DO $$
DECLARE
  stranded text;
BEGIN
  SELECT string_agg(format('%s: %s', col, n), ', ') INTO stranded FROM (
    SELECT 'build.tickets.customer_id' AS col, count(*) AS n FROM "build"."tickets" x
     WHERE x."customer_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "crm_org_party_map" m WHERE m.organization_id = x.org_id AND m."crm_organization_id" = x."customer_id")
    UNION ALL
    SELECT 'build.feedback_posts.crm_contact_id' AS col, count(*) AS n FROM "build"."feedback_posts" x
     WHERE x."crm_contact_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "contact_party_map" m WHERE m.organization_id = x.org_id AND m."contact_id" = x."crm_contact_id")
    UNION ALL
    SELECT 'build.feedback_posts.crm_organization_id' AS col, count(*) AS n FROM "build"."feedback_posts" x
     WHERE x."crm_organization_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "crm_org_party_map" m WHERE m.organization_id = x.org_id AND m."crm_organization_id" = x."crm_organization_id")
    UNION ALL
    SELECT 'build.feedbucket_submissions.crm_contact_id' AS col, count(*) AS n FROM "build"."feedbucket_submissions" x
     WHERE x."crm_contact_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "contact_party_map" m WHERE m.organization_id = x.org_id AND m."contact_id" = x."crm_contact_id")
    UNION ALL
    SELECT 'build.feedbucket_submissions.crm_organization_id' AS col, count(*) AS n FROM "build"."feedbucket_submissions" x
     WHERE x."crm_organization_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "crm_org_party_map" m WHERE m.organization_id = x.org_id AND m."crm_organization_id" = x."crm_organization_id")
  ) s WHERE n > 0;
  IF stranded IS NOT NULL THEN
    RAISE EXCEPTION '1097: refusing to repoint. These rows name a legacy id the party map does not hold (%). Backfill the map before running this.', stranded;
  END IF;
END $$;
--> statement-breakpoint

-- build.tickets.customer_id -> crm_org_party_map. Both old keys go: the
-- clients one because the column never meant a client, the composite one
-- because it is being re-added against the map under the same name.
ALTER TABLE "build"."tickets" DROP CONSTRAINT IF EXISTS "fk_tickets_customer";
--> statement-breakpoint
ALTER TABLE "build"."tickets" DROP CONSTRAINT IF EXISTS "fk_tickets_customer_id_org";
--> statement-breakpoint
ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_customer_id_org"
  FOREIGN KEY ("org_id", "customer_id") REFERENCES "public"."crm_org_party_map"("organization_id", "crm_organization_id") ON DELETE SET NULL ("customer_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_customer_id_org";
--> statement-breakpoint

ALTER TABLE "build"."feedback_posts" DROP CONSTRAINT IF EXISTS "fk_feedback_posts_crm_contact";
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" DROP CONSTRAINT IF EXISTS "fk_feedback_posts_crm_contact_id_org";
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_crm_contact_id_org"
  FOREIGN KEY ("org_id", "crm_contact_id") REFERENCES "public"."contact_party_map"("organization_id", "contact_id") ON DELETE SET NULL ("crm_contact_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" VALIDATE CONSTRAINT "fk_feedback_posts_crm_contact_id_org";
--> statement-breakpoint

ALTER TABLE "build"."feedback_posts" DROP CONSTRAINT IF EXISTS "fk_feedback_posts_crm_organization";
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" DROP CONSTRAINT IF EXISTS "fk_feedback_posts_crm_organization_id_org";
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_crm_organization_id_org"
  FOREIGN KEY ("org_id", "crm_organization_id") REFERENCES "public"."crm_org_party_map"("organization_id", "crm_organization_id") ON DELETE SET NULL ("crm_organization_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" VALIDATE CONSTRAINT "fk_feedback_posts_crm_organization_id_org";
--> statement-breakpoint

ALTER TABLE "build"."feedbucket_submissions" DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_crm_contact";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_crm_contact_id_org";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_crm_contact_id_org"
  FOREIGN KEY ("org_id", "crm_contact_id") REFERENCES "public"."contact_party_map"("organization_id", "contact_id") ON DELETE SET NULL ("crm_contact_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" VALIDATE CONSTRAINT "fk_feedbucket_submissions_crm_contact_id_org";
--> statement-breakpoint

-- The odd name out: the live key is `..._crm_org`, not `..._crm_organization`.
-- Both spellings are dropped so this is a no-op on a database that has either.
ALTER TABLE "build"."feedbucket_submissions" DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_crm_org";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_crm_organization";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_crm_organization_id_org";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_crm_organization_id_org"
  FOREIGN KEY ("org_id", "crm_organization_id") REFERENCES "public"."crm_org_party_map"("organization_id", "crm_organization_id") ON DELETE SET NULL ("crm_organization_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" VALIDATE CONSTRAINT "fk_feedbucket_submissions_crm_organization_id_org";
