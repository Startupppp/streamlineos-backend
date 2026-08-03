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
