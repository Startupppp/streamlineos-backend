CREATE TABLE crm_pricebooks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  currency TEXT NOT NULL DEFAULT 'INR',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMP,
  CONSTRAINT uniq_crm_pricebooks_org_name UNIQUE (org_id, name)
);
CREATE INDEX idx_crm_pricebooks_org ON crm_pricebooks(org_id);

CREATE TABLE crm_pricebook_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pricebook_id TEXT NOT NULL REFERENCES crm_pricebooks(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES crm_products(id) ON DELETE CASCADE,
  unit_price_cents INTEGER NOT NULL,
  min_quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_crm_pb_entry UNIQUE (org_id, pricebook_id, product_id, min_quantity)
);
CREATE INDEX idx_crm_pb_entries_pricebook ON crm_pricebook_entries(pricebook_id);
CREATE INDEX idx_crm_pb_entries_product ON crm_pricebook_entries(product_id);

CREATE TABLE crm_quote_settings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  max_discount_percent INTEGER,
  require_pricebook_price BOOLEAN NOT NULL DEFAULT FALSE,
  default_expiry_days INTEGER NOT NULL DEFAULT 30,
  allow_price_override BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_crm_quote_settings_org UNIQUE (org_id)
);

CREATE TABLE crm_quote_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  branding JSONB,
  terms TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMP,
  CONSTRAINT uniq_crm_quote_templates_org_name UNIQUE (org_id, name)
);
CREATE INDEX idx_crm_quote_templates_org ON crm_quote_templates(org_id);

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS pricebook_id TEXT REFERENCES crm_pricebooks(id) ON DELETE SET NULL;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS template_id TEXT REFERENCES crm_quote_templates(id) ON DELETE SET NULL;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS approval_status TEXT CHECK (approval_status IN ('pending','approved','rejected'));
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS approved_by_id TEXT REFERENCES users(id);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS signed_at TIMESTAMP;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS signed_document_ref TEXT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS converted_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL;

CREATE INDEX idx_quotes_pricebook ON quotes(pricebook_id);
CREATE INDEX idx_quotes_converted_invoice ON quotes(converted_invoice_id);
