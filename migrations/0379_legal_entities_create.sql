-- Batch 12 / S1 Wave 1: Introduce legal_entities table.
-- Pure expand — fully reversible via the companion .down.sql (DROP TABLE CASCADE).
--
-- Requires btree_gist for the named-entity non-overlap EXCLUDE constraint.
-- CREATE EXTENSION IF NOT EXISTS is idempotent; also add to the cold-DB setup
-- script alongside vector / pg_trgm / pgcrypto per migration-reproducibility rules.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE legal_entities (
  id                     text        PRIMARY KEY,
  org_id                 text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                   text        NOT NULL,
  legal_name             text        NOT NULL,
  country_code           text        NOT NULL DEFAULT 'IN',
  state_code             text,
  functional_currency    text        NOT NULL DEFAULT 'INR',
  gstin                  text,
  pan                    text,
  tan                    text,
  pf_establishment_code  text,
  esi_code               text,
  pt_registration_number text,
  lwf_code               text,
  cin                    text,
  llpin                  text,
  udyam_number           text,
  registered_address     jsonb,
  data_residency_region  text,
  invoice_prefix         text        NOT NULL DEFAULT 'INV',
  invoice_fy_reset       boolean     NOT NULL DEFAULT true,
  invoice_series         text        NOT NULL DEFAULT 'DEFAULT',
  status                 text        NOT NULL DEFAULT 'ACTIVE',
  effective_from         date        NOT NULL,
  effective_to           date        NOT NULL DEFAULT 'infinity'::date,
  parent_legal_entity_id text        REFERENCES legal_entities(id) ON DELETE SET NULL,
  org_unit_id            text        REFERENCES org_units(id) ON DELETE SET NULL,
  created_by             text        REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,

  CONSTRAINT chk_legal_entities_status
    CHECK (status IN ('ACTIVE', 'INACTIVE', 'DISSOLVED', 'MERGED')),

  CONSTRAINT chk_legal_entities_gstin_format
    CHECK (
      gstin IS NULL
      OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
    )
);

-- Composite tenant FK anchor: every tenant child uses (org_id, legal_entity_id)
-- so that a cross-tenant row is structurally impossible (north-star Rule 4).
CREATE UNIQUE INDEX uniq_legal_entities_org_id
  ON legal_entities (org_id, id);

-- Filter active entities for org settings page
CREATE INDEX idx_legal_entities_org_status
  ON legal_entities (org_id, status);

-- Multi-country entity filtering
CREATE INDEX idx_legal_entities_org_country
  ON legal_entities (org_id, country_code);

-- Prevent duplicate GSTIN within the same org (partial — skips rows without a GSTIN)
CREATE UNIQUE INDEX uniq_legal_entities_org_gstin
  ON legal_entities (org_id, gstin)
  WHERE gstin IS NOT NULL;

-- Prevent duplicate PAN within the same org
CREATE UNIQUE INDEX uniq_legal_entities_org_pan
  ON legal_entities (org_id, pan)
  WHERE pan IS NOT NULL;

-- Prevent two non-deleted rows for the same (org, name) from having overlapping
-- effective periods. Ensures "one active legal entity per name per org at a time."
-- btree_gist required for the text equality operators alongside the range &&.
ALTER TABLE legal_entities
  ADD CONSTRAINT excl_legal_entities_no_active_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    name   WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  )
  WHERE (deleted_at IS NULL);
