-- Custom SQL migration file, put your code below! --

-- Party becomes capable of replacing `leads`, `clients` and `contacts`.
--
-- Phase 1 put `business_parties` beside those three rather than in place of
-- them, so the same customer exists four times and every screen outside the
-- Phase 1 slice shows one of the wrong three. This is the expand half of
-- expand-contract: Party gains everything the legacy tables carry, and three map
-- tables make a legacy identifier resolvable to a Party. Nothing is removed,
-- nothing is read yet, and no behaviour changes.
--
-- The column names are the merged model's. `clients.gstin` is a tax number and
-- already had a column here. `leads.designation` and `contacts.title` are one
-- job title. `leads.assigned_to_id` and `clients.account_manager_id` are one
-- owner wearing whichever label the lifecycle stage gave them. Carrying three
-- names for one field into the new table would make the contract step a second
-- migration rather than a drop.
--
-- Every ADD COLUMN here is additive with a constant default, which Postgres
-- records as a catalogue entry and does not rewrite the table for, so the
-- NOT VALID/VALIDATE dance that 0214 needs for SET NOT NULL does not apply.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "business_parties"
  -- Person-shaped, from `contacts`, `leads` and `clients`.
  ADD COLUMN IF NOT EXISTS "job_title" text,
  ADD COLUMN IF NOT EXISTS "department" text,
  ADD COLUMN IF NOT EXISTS "company_name" text,
  ADD COLUMN IF NOT EXISTS "whatsapp_phone" text,
  ADD COLUMN IF NOT EXISTS "avatar_url" text,
  ADD COLUMN IF NOT EXISTS "linkedin_url" text,
  ADD COLUMN IF NOT EXISTS "social_profiles" jsonb,
  ADD COLUMN IF NOT EXISTS "city" text,
  ADD COLUMN IF NOT EXISTS "state" text,

  -- Lifecycle, from `leads`. Deliberately not folded into `status`: that column
  -- says whether the record is live, and NEW/QUALIFIED are not values of it.
  ADD COLUMN IF NOT EXISTS "lifecycle_stage" text,
  ADD COLUMN IF NOT EXISTS "priority" text,
  ADD COLUMN IF NOT EXISTS "qualification_score" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "converted_at" timestamp,
  ADD COLUMN IF NOT EXISTS "lost_reason" text,
  ADD COLUMN IF NOT EXISTS "sla_due_at" timestamp,
  ADD COLUMN IF NOT EXISTS "next_follow_up_at" timestamp,
  ADD COLUMN IF NOT EXISTS "follow_up_notes" text,

  -- Where the relationship came from. The UTM set, the IP and the referrer go
  -- into one jsonb because they describe the event that created the record and
  -- not the person; `crm_attribution` owns the full touch history.
  ADD COLUMN IF NOT EXISTS "acquisition_source" text,
  ADD COLUMN IF NOT EXISTS "acquisition_sub_source" text,
  ADD COLUMN IF NOT EXISTS "acquisition_campaign_id" integer,
  ADD COLUMN IF NOT EXISTS "acquisition_context" jsonb,
  ADD COLUMN IF NOT EXISTS "referred_by" text,

  -- Actor columns are plain text and never foreign keys to `users`: see 0223.
  -- `purge-user.mjs` deletes every row referencing a user without consulting the
  -- delete rule, so an FK here would make offboarding one salesperson delete
  -- their entire book of business.
  ADD COLUMN IF NOT EXISTS "owner_user_id" text,
  ADD COLUMN IF NOT EXISTS "assigned_by_user_id" text,
  ADD COLUMN IF NOT EXISTS "assigned_at" timestamp,
  ADD COLUMN IF NOT EXISTS "verified_by_user_id" text,

  ADD COLUMN IF NOT EXISTS "stated_budget" numeric(15, 2),
  ADD COLUMN IF NOT EXISTS "expected_value" numeric(15, 2),
  ADD COLUMN IF NOT EXISTS "lifetime_value" numeric(15, 2),

  -- Nullable, where `clients.health_score` defaults to 50 NOT NULL. A party that
  -- has never been a customer has no health, and defaulting it would put every
  -- lead on the health dashboard looking deliberately scored.
  ADD COLUMN IF NOT EXISTS "health_score" integer,
  ADD COLUMN IF NOT EXISTS "health_status" "crm_health",
  ADD COLUMN IF NOT EXISTS "health_checked_at" timestamp,
  ADD COLUMN IF NOT EXISTS "churn_risk_score" integer,
  ADD COLUMN IF NOT EXISTS "churn_risk_reasoning" text,

  -- text[], not `contacts`' jsonb array: tags are a set of scalars, and the
  -- array type is the one that can carry a GIN index for "filter by tag".
  ADD COLUMN IF NOT EXISTS "tags" text[] DEFAULT '{}'::text[] NOT NULL;

--> statement-breakpoint
/*
 * A single-column foreign key where the house style prefers the composite tenant
 * key, for a reason specific to this column: ON DELETE SET NULL on
 * ("organization_id", "acquisition_campaign_id") nulls *both* columns, and
 * "organization_id" is NOT NULL -- deleting a campaign would fail outright.
 * RESTRICT would instead start blocking campaign deletion the moment the
 * backfill runs, which is a behaviour change the expand is not allowed to make.
 * This mirrors `leads.campaign_id` exactly, cross-tenant gap included.
 */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_business_parties_acquisition_campaign'
  ) THEN
    ALTER TABLE "business_parties" ADD CONSTRAINT "fk_business_parties_acquisition_campaign"
      FOREIGN KEY ("acquisition_campaign_id") REFERENCES "crm_campaigns"("id")
      ON DELETE SET NULL NOT VALID;
    ALTER TABLE "business_parties" VALIDATE CONSTRAINT "fk_business_parties_acquisition_campaign";
  END IF;
END $$;

--> statement-breakpoint
-- The two reads the expand adds: my open pipeline, and my book of accounts.
-- Partial on deleted_at because the Drizzle declaration is partial; a full index
-- here would be silently recreated as partial by the next reconciliation, or the
-- other way round, and the planner would quietly stop using one of them.
CREATE INDEX IF NOT EXISTS "idx_business_parties_org_owner"
  ON "business_parties" ("organization_id", "owner_user_id", "lifecycle_stage")
  WHERE "deleted_at" IS NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_parties_org_stage"
  ON "business_parties" ("organization_id", "lifecycle_stage")
  WHERE "deleted_at" IS NULL;

--> statement-breakpoint
-- Leads with the campaign, not with organization_id, which is the one place the
-- house rule does not apply: this index exists for the foreign key's own
-- delete-time lookup, and ON DELETE SET NULL searches on the campaign alone with
-- no tenant predicate to lead with. Partial because almost every party has no
-- campaign, so the index stays a fraction of the table.
CREATE INDEX IF NOT EXISTS "idx_business_parties_campaign"
  ON "business_parties" ("acquisition_campaign_id")
  WHERE "acquisition_campaign_id" IS NOT NULL;

--> statement-breakpoint
/*
 * The composite foreign keys below need unique constraints on exactly
 * ("org_id", "id") and ("organization_id", "party_id"). Those exist in every
 * database that `drizzle-kit push` has touched, but as Drizzle declarations they
 * are not guaranteed in one built by running migrations in order -- see the same
 * note in 0228, where the omission would have aborted the whole series with
 * `42830: there is no unique constraint matching given keys`.
 *
 * Promotes an existing unique index rather than duplicating it, following
 * `0324_recon_directory_party_fks.sql`.
 */
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('uniq_leads_org_id',               'leads',            'org_id',          'id'),
      ('uniq_clients_org_id',             'clients',          'org_id',          'id'),
      ('uniq_contacts_org_id',            'contacts',         'org_id',          'id'),
      ('uniq_business_parties_org_party', 'business_parties', 'organization_id', 'party_id')
    ) AS t(constraint_name, table_name, first_column, second_column)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = target.constraint_name) THEN
      IF EXISTS (
        SELECT 1 FROM pg_class WHERE relname = target.constraint_name AND relkind = 'i'
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE USING INDEX %I',
          target.table_name, target.constraint_name, target.constraint_name
        );
      ELSE
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (%I, %I)',
          target.table_name, target.constraint_name,
          target.first_column, target.second_column
        );
      END IF;
    END IF;
  END LOOP;
END $$;

--> statement-breakpoint
/*
 * Which Party a legacy identifier means.
 *
 * One table per legacy kind rather than one polymorphic (kind, id) table. The
 * polymorphic shape is banned for new tables here (see 0228) and this is the
 * case where the reason bites hardest: it carries no referential integrity, so
 * nothing would stop a row pointing at a lead that no longer exists, and a
 * resolution that quietly returns the wrong person is worse than one that fails.
 * With real composite foreign keys, deleting the legacy row takes the mapping
 * with it and the resolver simply misses.
 *
 * Not unique on "party_id": after a merge, several legacy identifiers
 * legitimately answer to one surviving Party. That is what makes the merge
 * usable during the migration rather than a way to strand identifiers.
 *
 * `business_parties` needs no table here -- a party id resolves to itself, and
 * one identity row per party would double the table to store nothing.
 */
CREATE TABLE IF NOT EXISTS "lead_party_map" (
  "organization_id" text NOT NULL,
  "lead_id" integer NOT NULL,
  "party_id" text NOT NULL,
  -- Plain text, no FK to users: see 0223.
  "linked_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "pk_lead_party_map" PRIMARY KEY ("organization_id", "lead_id")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_party_map" (
  "organization_id" text NOT NULL,
  "client_id" integer NOT NULL,
  "party_id" text NOT NULL,
  "linked_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "pk_client_party_map" PRIMARY KEY ("organization_id", "client_id")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_party_map" (
  "organization_id" text NOT NULL,
  "contact_id" integer NOT NULL,
  "party_id" text NOT NULL,
  "linked_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "pk_contact_party_map" PRIMARY KEY ("organization_id", "contact_id")
);

--> statement-breakpoint
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('lead_party_map',    'lead_id',    'leads',    'org_id', 'id'),
      ('client_party_map',  'client_id',  'clients',  'org_id', 'id'),
      ('contact_party_map', 'contact_id', 'contacts', 'org_id', 'id')
    ) AS t(map_table, legacy_column, legacy_table, legacy_org_column, legacy_id_column)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'fk_' || target.map_table || '_org'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("organization_id")
           REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID',
        target.map_table, 'fk_' || target.map_table || '_org'
      );
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I',
        target.map_table, 'fk_' || target.map_table || '_org');
    END IF;

    -- CASCADE, not RESTRICT: hard-deleting a legacy row is existing behaviour and
    -- the expand may not start blocking it. The mapping goes with the row, which
    -- is exactly right -- there is nothing left to resolve.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'fk_' || target.map_table || '_legacy'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("organization_id", %I)
           REFERENCES %I(%I, %I) ON DELETE CASCADE NOT VALID',
        target.map_table, 'fk_' || target.map_table || '_legacy', target.legacy_column,
        target.legacy_table, target.legacy_org_column, target.legacy_id_column
      );
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I',
        target.map_table, 'fk_' || target.map_table || '_legacy');
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'fk_' || target.map_table || '_party'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("organization_id", "party_id")
           REFERENCES "business_parties"("organization_id", "party_id")
           ON DELETE CASCADE NOT VALID',
        target.map_table, 'fk_' || target.map_table || '_party'
      );
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I',
        target.map_table, 'fk_' || target.map_table || '_party');
    END IF;
  END LOOP;
END $$;

--> statement-breakpoint
-- The reverse read: which legacy ids this party answers to. A merge needs it to
-- re-point them onto the survivor.
CREATE INDEX IF NOT EXISTS "idx_lead_party_map_party"
  ON "lead_party_map" ("organization_id", "party_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_client_party_map_party"
  ON "client_party_map" ("organization_id", "party_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_party_map_party"
  ON "contact_party_map" ("organization_id", "party_id");

--> statement-breakpoint
DO $$
DECLARE
  map_table text;
BEGIN
  FOREACH map_table IN ARRAY ARRAY['lead_party_map', 'client_party_map', 'contact_party_map']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', map_table);
    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation" ON %I', map_table);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation" ON %I
         FOR ALL USING (organization_id = app.current_org_id())
         WITH CHECK (organization_id = app.current_org_id())',
      map_table
    );
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', map_table);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO streamline_app', map_table);
  END LOOP;
END $$;

--> statement-breakpoint
ANALYZE "business_parties";
