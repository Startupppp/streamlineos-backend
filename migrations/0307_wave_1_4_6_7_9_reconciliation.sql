-- 0307_wave_1_4_6_7_9_reconciliation.sql
-- Journals the schema changes applied this session (Waves 1/4/6/7/9) that were
-- previously applied to the dev branch via ad-hoc SQL. Idempotent + dependency-ordered:
-- new tables -> new columns -> Phase A org_id+triggers -> defect FKs -> Phase C candidate
-- keys -> Phase D composite FKs -> G1 membership composite FK -> T6.5 decouple.
-- NOTE: clean-DB reproducibility (GATE 0.4) must be proven by running db:migrate on a
-- fresh Neon branch — an operator step the AI cannot perform.

-- ===== wave-7-pm-workspaces.sql =====
-- ============================================================================
-- Wave 7 — PM Workspaces container (Organization → Product Management → PM Workspace).
-- Additive + idempotent (CREATE/ADD ... IF NOT EXISTS + guarded constraints) + provisioning
-- + backfill. Apply on the Neon BRANCH first. Matches the Drizzle schema (projects/pm-workspaces.ts,
-- projects/pm-workspace-memberships.ts) so a later db:generate/push sees no diff.
-- ============================================================================

-- §1. pm_workspaces (candidate key + one-default-per-org invariant) ----------
CREATE TABLE IF NOT EXISTS pm_workspaces (
  pm_workspace_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_pm_workspaces_org_workspace') THEN
    ALTER TABLE pm_workspaces
      ADD CONSTRAINT uniq_pm_workspaces_org_workspace UNIQUE (org_id, pm_workspace_id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pm_workspaces_org_default
  ON pm_workspaces (org_id) WHERE is_default = true;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pm_workspaces_org_slug ON pm_workspaces (org_id, slug);
CREATE INDEX IF NOT EXISTS idx_pm_workspaces_org ON pm_workspaces (org_id);

-- §2. pm_workspace_memberships (composite FK to pm_workspaces; references org membership) ----
CREATE TABLE IF NOT EXISTS pm_workspace_memberships (
  pm_workspace_membership_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pm_workspace_id text NOT NULL,
  organization_membership_id integer NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  added_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_pm_ws_members_org_ws_member') THEN
    ALTER TABLE pm_workspace_memberships
      ADD CONSTRAINT uniq_pm_ws_members_org_ws_member UNIQUE (org_id, pm_workspace_id, organization_membership_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pm_ws_members_org_workspace') THEN
    ALTER TABLE pm_workspace_memberships
      ADD CONSTRAINT fk_pm_ws_members_org_workspace
      FOREIGN KEY (org_id, pm_workspace_id)
      REFERENCES pm_workspaces (org_id, pm_workspace_id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_pm_ws_members_org_ws ON pm_workspace_memberships (org_id, pm_workspace_id);
CREATE INDEX IF NOT EXISTS idx_pm_ws_members_membership ON pm_workspace_memberships (organization_membership_id);

-- §3. Nullable pm_workspace_id on PM children (additive) ----------------------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pm_workspace_id text;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS pm_workspace_id text;
ALTER TABLE project_teams ADD COLUMN IF NOT EXISTS pm_workspace_id text;
ALTER TABLE project_workspace_members ADD COLUMN IF NOT EXISTS pm_workspace_id text;

-- §4. Provisioning: exactly one default PM Workspace per ELIGIBLE org (has PM data OR
--     Product Management enabled). Idempotent via the partial-unique default + NOT EXISTS guard.
INSERT INTO pm_workspaces (pm_workspace_id, org_id, name, slug, is_default, status)
SELECT gen_random_uuid()::text, o.id, 'Default Workspace', 'default', true, 'active'
FROM organizations o
WHERE NOT EXISTS (
    SELECT 1 FROM pm_workspaces w WHERE w.org_id = o.id AND w.is_default = true
  )
  AND (
    EXISTS (SELECT 1 FROM projects p WHERE p.org_id = o.id)
    OR EXISTS (SELECT 1 FROM managed_products m WHERE m.org_id = o.id)
    OR EXISTS (SELECT 1 FROM project_workspace_members pwm WHERE pwm.org_id = o.id)
    OR ('PROJECTS' = ANY(COALESCE(o.enabled_modules, '{}')))
  );

-- §5. Backfill pm_workspace_id on PM children to their org's default workspace ---------------
UPDATE projects p SET pm_workspace_id = w.pm_workspace_id
  FROM pm_workspaces w
  WHERE w.org_id = p.org_id AND w.is_default = true AND p.pm_workspace_id IS NULL;
UPDATE managed_products m SET pm_workspace_id = w.pm_workspace_id
  FROM pm_workspaces w
  WHERE w.org_id = m.org_id AND w.is_default = true AND m.pm_workspace_id IS NULL;
UPDATE project_teams t SET pm_workspace_id = w.pm_workspace_id
  FROM pm_workspaces w
  WHERE w.org_id = t.org_id AND w.is_default = true AND t.pm_workspace_id IS NULL;
UPDATE project_workspace_members pwm SET pm_workspace_id = w.pm_workspace_id
  FROM pm_workspaces w
  WHERE w.org_id = pwm.org_id AND w.is_default = true AND pwm.pm_workspace_id IS NULL;

-- §6. Backfill pm_workspace_memberships from the existing org roster (project_workspace_members) ----
INSERT INTO pm_workspace_memberships (pm_workspace_membership_id, org_id, pm_workspace_id, organization_membership_id, role)
SELECT gen_random_uuid()::text, pwm.org_id, w.pm_workspace_id, om.id, 'member'
FROM project_workspace_members pwm
JOIN pm_workspaces w ON w.org_id = pwm.org_id AND w.is_default = true
JOIN organization_members om ON om.org_id = pwm.org_id AND om.user_id = pwm.user_id
ON CONFLICT (org_id, pm_workspace_id, organization_membership_id) DO NOTHING;

-- ============================================================================
-- VERIFY (read-only): default-workspace count == eligible-org count; no PM child left unbackfilled.
--   SELECT count(*) FROM pm_workspaces WHERE is_default = true;
--   SELECT count(*) FROM projects WHERE pm_workspace_id IS NULL;   -- expect 0 for eligible orgs
-- Deferred (Wave 7 follow-up): composite FKs projects/managed_products/project_teams
--   (org_id, pm_workspace_id) → pm_workspaces(org_id, pm_workspace_id) once pm_workspace_id is NOT NULL.
-- ============================================================================

-- ===== wave-6-offer-fulfillment.sql =====
-- wave-6-offer-fulfillment.sql  (T6.4)
-- Integration-owned CRM Offer ↔ Inventory SKU fulfillment mapping.
-- No FK into crm_products or inv_product_variants (module decoupling); only the
-- tenant org_id FK is DB-enforced. Idempotent + transactional.

BEGIN;

CREATE TABLE IF NOT EXISTS offer_fulfillment_components (
  offer_fulfillment_component_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  crm_offer_id      integer     NOT NULL,
  crm_offer_org_id  text        NOT NULL,
  inv_sku_id        integer     NOT NULL,
  inv_sku_org_id    text        NOT NULL,
  quantity_per_unit numeric(10,4) NOT NULL DEFAULT '1',
  uom               text,
  status            text        NOT NULL DEFAULT 'active',
  effective_from    timestamp,
  effective_to      timestamp,
  notes             text,
  created_by        text        NOT NULL REFERENCES users(id),
  created_at        timestamp   NOT NULL DEFAULT now(),
  updated_at        timestamp   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_offer_fulfillment_components_org_offer_sku
  ON offer_fulfillment_components (org_id, crm_offer_id, inv_sku_id);

CREATE INDEX IF NOT EXISTS idx_offer_fulfillment_components_offer
  ON offer_fulfillment_components (org_id, crm_offer_id);

CREATE INDEX IF NOT EXISTS idx_offer_fulfillment_components_sku
  ON offer_fulfillment_components (org_id, inv_sku_id);

COMMIT;

-- ===== wave-6-party-overlays.sql =====
-- Wave 6 T6.1-overlays: CRM + Inventory party overlay tables
-- Idempotent — safe to run multiple times.

-- ============================================================
-- 1. crm_party_accounts
-- ============================================================

CREATE TABLE IF NOT EXISTS crm_party_accounts (
  crm_account_id        TEXT        NOT NULL,
  org_id                TEXT        NOT NULL,
  lead_id               INTEGER,
  account_manager_id    TEXT,
  health_score          INTEGER     NOT NULL DEFAULT 50,
  health_status         TEXT        NOT NULL DEFAULT 'healthy',
  last_health_check     TIMESTAMP,
  churn_risk_score      INTEGER,
  churn_risk_reasoning  TEXT,
  investment_value      DECIMAL(15, 2),
  converted_at          TIMESTAMP,
  crm_organization_id   INTEGER,
  created_at            TIMESTAMP   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP   NOT NULL DEFAULT NOW(),

  CONSTRAINT crm_party_accounts_pkey
    PRIMARY KEY (crm_account_id),

  CONSTRAINT crm_party_accounts_crm_account_id_fkey
    FOREIGN KEY (crm_account_id)
    REFERENCES business_parties (party_id)
    ON DELETE CASCADE,

  CONSTRAINT crm_party_accounts_org_id_fkey
    FOREIGN KEY (org_id)
    REFERENCES organizations (id)
    ON DELETE CASCADE,

  CONSTRAINT crm_party_accounts_lead_id_fkey
    FOREIGN KEY (lead_id)
    REFERENCES leads (id)
    ON DELETE SET NULL,

  CONSTRAINT crm_party_accounts_account_manager_id_fkey
    FOREIGN KEY (account_manager_id)
    REFERENCES users (id)
    ON DELETE SET NULL,

  CONSTRAINT crm_party_accounts_crm_organization_id_fkey
    FOREIGN KEY (crm_organization_id)
    REFERENCES crm_organizations (id)
    ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_party_accounts_org_party
  ON crm_party_accounts (org_id, crm_account_id);

CREATE INDEX IF NOT EXISTS idx_crm_party_accounts_account_manager
  ON crm_party_accounts (account_manager_id);

CREATE INDEX IF NOT EXISTS idx_crm_party_accounts_org_health
  ON crm_party_accounts (org_id, health_status);

-- ============================================================
-- 2. inv_party_vendor_profiles
-- ============================================================

CREATE TABLE IF NOT EXISTS inv_party_vendor_profiles (
  vendor_profile_id     TEXT        NOT NULL,
  org_id                TEXT        NOT NULL,
  vendor_code           TEXT        NOT NULL,
  lead_time_days        INTEGER     NOT NULL DEFAULT 7,
  payment_terms_days    INTEGER     NOT NULL DEFAULT 30,
  currency              TEXT        NOT NULL DEFAULT 'INR',
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  notes                 TEXT,
  created_by            TEXT        NOT NULL,
  created_at            TIMESTAMP   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP   NOT NULL DEFAULT NOW(),

  CONSTRAINT inv_party_vendor_profiles_pkey
    PRIMARY KEY (vendor_profile_id),

  CONSTRAINT inv_party_vendor_profiles_vendor_profile_id_fkey
    FOREIGN KEY (vendor_profile_id)
    REFERENCES business_parties (party_id)
    ON DELETE CASCADE,

  CONSTRAINT inv_party_vendor_profiles_org_id_fkey
    FOREIGN KEY (org_id)
    REFERENCES organizations (id)
    ON DELETE CASCADE,

  CONSTRAINT inv_party_vendor_profiles_created_by_fkey
    FOREIGN KEY (created_by)
    REFERENCES users (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_vendor_profile_org_code
  ON inv_party_vendor_profiles (org_id, vendor_code);

CREATE INDEX IF NOT EXISTS idx_inv_vendor_profile_org
  ON inv_party_vendor_profiles (org_id);

-- ===== wave-1-step1-2-org-invitation-lifecycle.sql =====
-- wave-1-step1-2-org-invitation-lifecycle.sql
-- Step 1: organization status enum + purge lifecycle columns (additive, nullable).
-- Step 2: invitation status enum + inviter/accepted membership + lifecycle columns + backfill.
-- Idempotent. NOT NULL contraction on status_v2 deferred (shadow phase).

DO $$ BEGIN CREATE TYPE organization_status AS ENUM ('ACTIVE','ARCHIVED','PURGE_SCHEDULED','PURGED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE invitation_status AS ENUM ('PENDING','ACCEPTED','DECLINED','EXPIRED','REVOKED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS status_v2 organization_status,
  ADD COLUMN IF NOT EXISTS purge_scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS purge_scheduled_by integer,
  ADD COLUMN IF NOT EXISTS purge_job_id text,
  ADD COLUMN IF NOT EXISTS purged_at timestamptz,
  ADD COLUMN IF NOT EXISTS purge_reason text;
CREATE INDEX IF NOT EXISTS idx_orgs_purge_scheduled ON organizations (purge_scheduled_at) WHERE status = 'PURGE_SCHEDULED';

ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS status invitation_status NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS inviter_membership_id integer,
  ADD COLUMN IF NOT EXISTS accepted_membership_id integer,
  ADD COLUMN IF NOT EXISTS declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_by integer;

UPDATE invitations SET status = CASE
  WHEN accepted_at IS NOT NULL THEN 'ACCEPTED'::invitation_status
  WHEN expires_at < now() THEN 'EXPIRED'::invitation_status
  ELSE 'PENDING'::invitation_status END
WHERE status = 'PENDING';

UPDATE invitations i SET inviter_membership_id = om.id
FROM organization_members om
WHERE om.user_id = i.invited_by AND om.org_id = i.org_id AND i.inviter_membership_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations (org_id, status);

-- ===== wave-7-g5-managed-products-fields.sql =====
-- Wave 7 G5: Add product-strategy fields to managed_products
-- Idempotent: all statements use IF NOT EXISTS guards.

ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS vision text;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS mission_statement text;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS target_customer text;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS differentiators text;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS current_phase text;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS target_launch_date timestamptz;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS success_metrics jsonb;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS owner_membership_id integer;

-- Guard the unique constraint on (org_id, managed_product_id) — add only if absent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = 'managed_products'::regclass
    AND    conname  = 'uniq_managed_products_org_pk'
  ) THEN
    ALTER TABLE managed_products
      ADD CONSTRAINT uniq_managed_products_org_pk
      UNIQUE (org_id, managed_product_id);
  END IF;
END;
$$;

-- ===== wave-9-email-outbox-orgid.sql =====
-- wave-9-email-outbox-orgid.sql  (Cluster B — email outbox org-scoping)
-- Additive nullable organization_id on email_outbox + index for org-scoped
-- retry/observability. NOT NULL deferred (per plan Phase 2.4). Idempotent.
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS organization_id text;
CREATE INDEX IF NOT EXISTS email_outbox_org_idx ON email_outbox (organization_id, status);

-- ===== wave-4-phase-a-orgid-backfill.sql =====
-- wave-4-phase-a-orgid-backfill.sql  (Wave 4 Phase A — denormalized tenant org_id)
-- Adds a SELF-MAINTAINING org_id to tenant line-item/junction tables that lacked one.
-- For every public table without org_id/organization_id that has a NOT-NULL single-column
-- FK to an org-bearing parent: add org_id, backfill it from that parent, install a
-- BEFORE INSERT trigger that auto-derives org_id from the parent (so NO service-code change
-- is needed and the column can safely be NOT NULL), then add NOT NULL + org FK +
-- (org_id, pk) candidate key. Global/platform tables (no org-bearing parent) are skipped.
-- Idempotent + re-runnable. Applied + verified on the Neon dev branch: 66 tables, 0 failures.
-- (Enables +116 Phase-D composite FKs once these tables carry org_id.)

CREATE OR REPLACE FUNCTION set_org_id_from_parent() RETURNS trigger AS $fn$
DECLARE fk_val text; v_org text;
BEGIN
  IF (to_jsonb(NEW) ->> 'org_id') IS NOT NULL THEN RETURN NEW; END IF;
  fk_val := to_jsonb(NEW) ->> TG_ARGV[3];
  IF fk_val IS NULL THEN RETURN NEW; END IF;
  EXECUTE format('SELECT %I::text FROM %I WHERE %I::text = $1', TG_ARGV[2], TG_ARGV[0], TG_ARGV[1])
    INTO v_org USING fk_val;
  NEW.org_id := v_org;
  RETURN NEW;
END; $fn$ LANGUAGE plpgsql;

DO $$
DECLARE r RECORD; p RECORD; nulls int; fkname text; ck text; pkcol text;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
    WHERE c.relkind='r'
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname IN ('org_id','organization_id') AND NOT a.attisdropped)
  LOOP
    -- pick a NOT-NULL single-col FK to an org-bearing parent (prefer the CASCADE/owning parent)
    SELECT ca.attname AS fk_col, parent.relname AS parent_table, pa.attname AS parent_pk, porg.attname AS parent_org
      INTO p
    FROM pg_constraint con
    JOIN pg_class parent ON parent.oid=con.confrelid
    JOIN pg_attribute ca ON ca.attrelid=con.conrelid AND ca.attnum=con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid=con.confrelid AND pa.attnum=con.confkey[1]
    JOIN LATERAL (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=con.confrelid AND a.attname IN ('org_id','organization_id') AND NOT a.attisdropped ORDER BY CASE a.attname WHEN 'org_id' THEN 0 ELSE 1 END LIMIT 1) porg ON true
    WHERE con.conrelid=r.oid AND con.contype='f' AND array_length(con.conkey,1)=1 AND ca.attnotnull
    ORDER BY CASE WHEN con.confdeltype='c' THEN 0 ELSE 1 END
    LIMIT 1;
    IF p.fk_col IS NULL THEN CONTINUE; END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS org_id text', r.relname);
    EXECUTE format('UPDATE %I c SET org_id = pp.%I FROM %I pp WHERE pp.%I = c.%I AND c.org_id IS NULL',
                   r.relname, p.parent_org, p.parent_table, p.parent_pk, p.fk_col);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_set_org_id ON %I', r.relname);
    EXECUTE format('CREATE TRIGGER trg_set_org_id BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent(%L,%L,%L,%L)',
                   r.relname, p.parent_table, p.parent_pk, p.parent_org, p.fk_col);
    EXECUTE format('SELECT count(*) FROM %I WHERE org_id IS NULL', r.relname) INTO nulls;
    IF nulls > 0 THEN CONTINUE; END IF;

    EXECUTE format('ALTER TABLE %I ALTER COLUMN org_id SET NOT NULL', r.relname);
    fkname := left(r.relname || '_org_id_fk', 63);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=fkname AND conrelid=r.oid) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE', r.relname, fkname);
    END IF;
    SELECT a.attname INTO pkcol
    FROM pg_constraint pc JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=pc.conkey[1]
    WHERE pc.conrelid=r.oid AND pc.contype='p' AND array_length(pc.conkey,1)=1 LIMIT 1;
    IF pkcol IS NOT NULL THEN
      ck := left('uniq_' || r.relname || '_org_id', 63);
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=ck AND conrelid=r.oid) THEN
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (org_id, %I)', r.relname, ck, pkcol);
      END IF;
    END IF;
  END LOOP;
END $$;

-- ===== wave-4-defect-fks.sql =====
-- wave-4-defect-fks.sql  (Phase B.3 — P1 tenant-integrity defect FKs)
-- Bare org_id columns that were declared NOT NULL but never FK-constrained to
-- organizations. Idempotent; guarded on pg_constraint. Tables verified empty
-- (zero orphan org_id) on the dev branch before application.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_comment_reactions_org_id_organizations_fk'
  ) THEN
    ALTER TABLE ticket_comment_reactions
      ADD CONSTRAINT ticket_comment_reactions_org_id_organizations_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_automations_org_id_organizations_fk'
  ) THEN
    ALTER TABLE project_automations
      ADD CONSTRAINT project_automations_org_id_organizations_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END$$;

COMMIT;

-- ===== wave-4-phase-c-candidate-keys.sql =====
-- wave-4-phase-c-candidate-keys.sql  (Wave 4 Phase C — tenant candidate keys)
-- Adds a UNIQUE (org_id, <pk>) CONSTRAINT to every public tenant parent table
-- that has a NOT-NULL org_id/organization_id column + a single-column primary key
-- and lacks such a constraint. These candidate keys are the FK targets that Phase D
-- composite (org_id, child_fk) -> parent(org_id, pk) foreign keys require (a plain
-- UNIQUE INDEX does not satisfy Postgres FK-target rules — a UNIQUE CONSTRAINT does).
--
-- Idempotent + drift-tolerant: skips tables already covered, and any table whose PK
-- column IS the org column (e.g. access_versions). Zero-risk to apply — (org_id, pk)
-- is trivially unique because pk is the primary key. Applied + verified on the Neon
-- dev branch (665/666 qualifying tables constrained).

DO $$
DECLARE
  r RECORD;
  cname text;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, c.oid AS reloid,
           org.attname AS org_col, org.attnum AS org_num,
           pk.attname  AS pk_col,  pk.attnum  AS pk_num
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN LATERAL (
      SELECT a.attname, a.attnum
      FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname IN ('org_id','organization_id') AND a.attnotnull
      ORDER BY CASE a.attname WHEN 'org_id' THEN 0 ELSE 1 END
      LIMIT 1
    ) org ON true
    JOIN LATERAL (
      SELECT a.attname, a.attnum
      FROM pg_constraint pc
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = pc.conkey[1]
      WHERE pc.conrelid = c.oid AND pc.contype = 'p' AND array_length(pc.conkey,1) = 1
      LIMIT 1
    ) pk ON true
    WHERE c.relkind = 'r' AND org.attnum <> pk.attnum
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = r.reloid AND contype = 'u'
        AND array_length(conkey, 1) = 2
        AND conkey @> ARRAY[r.org_num, r.pk_num]::smallint[]
    ) THEN
      CONTINUE;
    END IF;
    cname := left('uniq_' || r.tbl || '_org_id', 63);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (%I, %I)',
      r.tbl, cname, r.org_col, r.pk_col
    );
  END LOOP;
END $$;

-- ===== wave-4-phase-d-composite-fks.sql =====
-- wave-4-phase-d-composite-fks.sql  (Wave 4 Phase D — tenant composite FKs)
-- For every single-column FK whose CHILD has a NOT-NULL org column and whose PARENT
-- has a (org, pk) candidate key (added in Phase C), adds a SUPPLEMENTARY composite
-- foreign key (child_org, child_fk) -> parent(org, pk). This makes a child row
-- unable to reference a parent in a DIFFERENT org — tenant-scoped referential
-- integrity (OWASP A01 / §20 defense-in-depth).
--
-- ON DELETE NO ACTION deliberately: the composite FK only ENFORCES the org match; the
-- pre-existing single-column FK keeps its own delete behavior (cascade / set null), so
-- the two never impose conflicting delete semantics. Idempotent + drift-tolerant.
-- Applied + verified on the Neon dev branch: 535 composite FKs, 0 cross-tenant orphans.

DO $$
DECLARE
  r RECORD;
  cname text;
BEGIN
  FOR r IN
    SELECT child.oid AS child_oid, child.relname AS child_table, ca.attname AS child_col,
           parent.relname AS parent_table, pa.attname AS parent_col, pa.attnum AS parent_col_num,
           parent.oid AS parent_oid, childorg.attname AS child_org_col,
           parentorg.attname AS parent_org_col, parentorg.attnum AS parent_org_num
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace cn ON cn.oid = child.relnamespace AND cn.nspname = 'public'
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
    JOIN LATERAL (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=child.oid AND a.attname IN ('org_id','organization_id') AND a.attnotnull AND NOT a.attisdropped ORDER BY CASE a.attname WHEN 'org_id' THEN 0 ELSE 1 END LIMIT 1) childorg ON true
    JOIN LATERAL (SELECT a.attname, a.attnum FROM pg_attribute a WHERE a.attrelid=parent.oid AND a.attname IN ('org_id','organization_id') AND NOT a.attisdropped ORDER BY CASE a.attname WHEN 'org_id' THEN 0 ELSE 1 END LIMIT 1) parentorg ON true
    WHERE con.contype = 'f' AND array_length(con.conkey,1) = 1
  LOOP
    -- parent must have a (org, refcol) unique/pk candidate key to target
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = r.parent_oid AND contype IN ('u','p') AND array_length(conkey,1) = 2
        AND conkey @> ARRAY[r.parent_org_num, r.parent_col_num]::smallint[]
    ) THEN CONTINUE; END IF;
    -- skip if a composite FK from this child to this parent already exists
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = r.child_oid AND contype = 'f' AND array_length(conkey,1) = 2
        AND confrelid = r.parent_oid
    ) THEN CONTINUE; END IF;
    cname := left('fk_' || r.child_table || '_' || r.child_col || '_org', 63);
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = cname AND conrelid = r.child_oid) THEN CONTINUE; END IF;
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I, %I) REFERENCES %I(%I, %I)',
      r.child_table, cname, r.child_org_col, r.child_col, r.parent_table, r.parent_org_col, r.parent_col
    );
  END LOOP;
END $$;

-- ===== G1: composite membership FK on pm_workspace_memberships =====
DO $g1$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='pm_workspace_memberships')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_pm_ws_members_org_membership') THEN
    ALTER TABLE pm_workspace_memberships ADD CONSTRAINT fk_pm_ws_members_org_membership
      FOREIGN KEY (org_id, organization_membership_id) REFERENCES organization_members(org_id, id) ON DELETE CASCADE;
  END IF;
END $g1$;

-- ===== T6.5: decouple projects from crm_organizations =====
-- wave-6-t6.5-decouple-projects-crm.sql
-- Decouple Projects from CRM schema (ADR): tickets.customer_id no longer hard-FKs
-- into crm_organizations. The Drizzle import + relation were removed; customer_id
-- becomes a soft reference resolved at the service layer. Idempotent.
DO $$
DECLARE cn text;
BEGIN
  SELECT con.conname INTO cn FROM pg_constraint con
    JOIN pg_class child ON child.oid=con.conrelid
    JOIN pg_class parent ON parent.oid=con.confrelid
    JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=con.conkey[1]
    WHERE child.relname='tickets' AND parent.relname='crm_organizations'
      AND con.contype='f' AND a.attname='customer_id' LIMIT 1;
  IF cn IS NOT NULL THEN EXECUTE format('ALTER TABLE tickets DROP CONSTRAINT %I', cn); END IF;
END $$;
