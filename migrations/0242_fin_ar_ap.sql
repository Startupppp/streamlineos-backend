-- Migration 0242: Finance AR/AP — credit notes, allocations, recurring templates, reminders, collection, payment runs

DO $$ BEGIN
  CREATE TYPE fin_credit_note_status AS ENUM ('DRAFT', 'POSTED', 'APPLIED', 'VOID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_reminder_channel AS ENUM ('EMAIL', 'WHATSAPP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_collection_activity_type AS ENUM ('NOTE', 'PROMISE_TO_PAY', 'CALL', 'EMAIL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_payment_run_status AS ENUM ('DRAFT', 'APPROVED', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_payment_run_item_status AS ENUM ('PENDING', 'PAID', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS credit_notes (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  credit_note_number text NOT NULL,
  client_id integer REFERENCES clients(id),
  invoice_id integer REFERENCES invoices(id) ON DELETE SET NULL,
  status fin_credit_note_status NOT NULL DEFAULT 'DRAFT',
  reason text,
  subtotal decimal(18,4) NOT NULL DEFAULT 0,
  tax_amount decimal(18,4) NOT NULL DEFAULT 0,
  cgst_amount decimal(18,4) NOT NULL DEFAULT 0,
  sgst_amount decimal(18,4) NOT NULL DEFAULT 0,
  igst_amount decimal(18,4) NOT NULL DEFAULT 0,
  total decimal(18,4) NOT NULL DEFAULT 0,
  applied_amount decimal(18,4) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'INR',
  place_of_supply text,
  customer_gstin text,
  supplier_gstin text,
  notes text,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_credit_notes_org_number UNIQUE (org_id, credit_note_number)
);
CREATE INDEX IF NOT EXISTS idx_credit_notes_org_status ON credit_notes (org_id, status);
CREATE INDEX IF NOT EXISTS idx_credit_notes_client ON credit_notes (client_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice ON credit_notes (invoice_id);

CREATE TABLE IF NOT EXISTS credit_note_items (
  id serial PRIMARY KEY,
  credit_note_id integer NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  description text NOT NULL,
  hsn_sac_code text,
  quantity decimal(18,4) NOT NULL,
  rate decimal(18,4) NOT NULL,
  gst_rate decimal(5,2) NOT NULL,
  amount decimal(18,4) NOT NULL,
  line_order integer NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_note_items_cn ON credit_note_items (credit_note_id);

CREATE TABLE IF NOT EXISTS fin_payment_allocations (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payment_id integer NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id integer NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount decimal(18,4) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_fin_payment_allocations_pay_inv UNIQUE (payment_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_fin_payment_allocations_org ON fin_payment_allocations (org_id);
CREATE INDEX IF NOT EXISTS idx_fin_payment_allocations_invoice ON fin_payment_allocations (invoice_id);

CREATE TABLE IF NOT EXISTS vendor_credits (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_credit_number text NOT NULL,
  vendor_id integer REFERENCES clients(id),
  bill_id integer REFERENCES purchase_bills(id) ON DELETE SET NULL,
  status fin_credit_note_status NOT NULL DEFAULT 'DRAFT',
  reason text,
  subtotal decimal(18,4) NOT NULL DEFAULT 0,
  tax_amount decimal(18,4) NOT NULL DEFAULT 0,
  total decimal(18,4) NOT NULL DEFAULT 0,
  applied_amount decimal(18,4) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'INR',
  notes text,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_vendor_credits_org_number UNIQUE (org_id, vendor_credit_number)
);
CREATE INDEX IF NOT EXISTS idx_vendor_credits_org_status ON vendor_credits (org_id, status);
CREATE INDEX IF NOT EXISTS idx_vendor_credits_vendor ON vendor_credits (vendor_id);

CREATE TABLE IF NOT EXISTS vendor_credit_items (
  id serial PRIMARY KEY,
  vendor_credit_id integer NOT NULL REFERENCES vendor_credits(id) ON DELETE CASCADE,
  description text NOT NULL,
  hsn_sac_code text,
  quantity decimal(18,4) NOT NULL,
  rate decimal(18,4) NOT NULL,
  gst_rate decimal(5,2) NOT NULL,
  amount decimal(18,4) NOT NULL,
  line_order integer NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vendor_credit_items_vc ON vendor_credit_items (vendor_credit_id);

CREATE TABLE IF NOT EXISTS fin_vendor_payment_allocations (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_payment_id integer NOT NULL REFERENCES vendor_payments(id) ON DELETE CASCADE,
  bill_id integer NOT NULL REFERENCES purchase_bills(id) ON DELETE CASCADE,
  amount decimal(18,4) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_fin_vendor_pay_alloc_pay_bill UNIQUE (vendor_payment_id, bill_id)
);
CREATE INDEX IF NOT EXISTS idx_fin_vendor_payment_allocations_org ON fin_vendor_payment_allocations (org_id);
CREATE INDEX IF NOT EXISTS idx_fin_vendor_payment_allocations_bill ON fin_vendor_payment_allocations (bill_id);

CREATE TABLE IF NOT EXISTS fin_recurring_invoice_templates (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  client_id integer REFERENCES clients(id),
  frequency fin_recur_frequency NOT NULL,
  next_run_date date,
  last_run_date date,
  end_date date,
  is_active boolean NOT NULL DEFAULT true,
  payload jsonb NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_recurring_invoice_templates_org ON fin_recurring_invoice_templates (org_id);

CREATE TABLE IF NOT EXISTS fin_recurring_bill_templates (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  vendor_id integer REFERENCES clients(id),
  frequency fin_recur_frequency NOT NULL,
  next_run_date date,
  last_run_date date,
  end_date date,
  is_active boolean NOT NULL DEFAULT true,
  payload jsonb NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_recurring_bill_templates_org ON fin_recurring_bill_templates (org_id);

CREATE TABLE IF NOT EXISTS fin_reminder_policies (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  offsets jsonb NOT NULL,
  channel fin_reminder_channel NOT NULL DEFAULT 'EMAIL',
  template text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_reminder_policies_org ON fin_reminder_policies (org_id);

CREATE TABLE IF NOT EXISTS fin_reminder_log (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id integer NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  sent_at timestamp NOT NULL DEFAULT now(),
  channel fin_reminder_channel NOT NULL,
  offset_days integer NOT NULL,
  status text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fin_reminder_log_org_invoice ON fin_reminder_log (org_id, invoice_id);

CREATE TABLE IF NOT EXISTS fin_collection_activities (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id integer NOT NULL REFERENCES clients(id),
  invoice_id integer REFERENCES invoices(id) ON DELETE SET NULL,
  type fin_collection_activity_type NOT NULL,
  note text,
  promised_date date,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_collection_activities_org_client ON fin_collection_activities (org_id, client_id);
CREATE INDEX IF NOT EXISTS idx_fin_collection_activities_invoice ON fin_collection_activities (invoice_id);

CREATE TABLE IF NOT EXISTS fin_payment_runs (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  status fin_payment_run_status NOT NULL DEFAULT 'DRAFT',
  scheduled_date date,
  total_amount decimal(18,4) NOT NULL DEFAULT 0,
  created_by text NOT NULL REFERENCES users(id),
  approved_by text REFERENCES users(id),
  approved_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_payment_runs_org_status ON fin_payment_runs (org_id, status);

CREATE TABLE IF NOT EXISTS fin_payment_run_items (
  id serial PRIMARY KEY,
  run_id integer NOT NULL REFERENCES fin_payment_runs(id) ON DELETE CASCADE,
  bill_id integer NOT NULL REFERENCES purchase_bills(id),
  vendor_id integer REFERENCES clients(id),
  amount decimal(18,4) NOT NULL,
  status fin_payment_run_item_status NOT NULL DEFAULT 'PENDING',
  vendor_payment_id integer REFERENCES vendor_payments(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_payment_run_items_run ON fin_payment_run_items (run_id);
CREATE INDEX IF NOT EXISTS idx_fin_payment_run_items_bill ON fin_payment_run_items (bill_id);
