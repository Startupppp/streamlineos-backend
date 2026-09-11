-- Custom SQL migration file, put your code below! --

-- Every `client_id` gains a party, so the legacy identity tables can eventually go.
--
-- Phase 2, ticket 08 -- the expand half. The reader register got down to five and
-- that turned out not to be what gates the drop. A reader is a file to edit; a
-- **foreign key** is a column in somebody else's table, and `clients` is pointed
-- at by twelve of them across accounting, inventory, support, build and
-- timesheets. `DROP TABLE` refuses on the key, not on the import.
--
-- Expand only. Every `client_id` stays exactly where it is and every existing
-- reader keeps working; the new column is populated beside it and a later
-- migration drops the old one once nothing reads it. Doing both at once would
-- break six modules simultaneously for a benefit nobody could ship in pieces.
--
-- The new columns are named for the role they carry rather than all being
-- `party_id`: `purchase_bills.vendor_id` and `build.tickets.customer_id` point at
-- the same table for different reasons, and flattening all three to one name
-- would lose the only thing that says which. `deals` already carries `party_id`
-- and is deliberately absent.
--
-- Nullable, including where the old column is NOT NULL. A backfill cannot make a
-- column non-null in the same statement that adds it without rewriting the
-- table under a lock, and the constraint belongs to the contract migration
-- anyway -- until then a null means "not yet backfilled", which is a state worth
-- being able to see.

SET lock_timeout = '5s';

-- build.tickets.customer_id
ALTER TABLE build.tickets ADD COLUMN IF NOT EXISTS customer_party_id text;

UPDATE build.tickets t
   SET customer_party_id = m.party_id
  FROM client_party_map m
 WHERE m.client_id = t.customer_id
   AND m.organization_id = t.org_id
   AND t.customer_party_id IS NULL
   AND t.customer_id IS NOT NULL;

-- Composite, so a row cannot point at another tenant's party. A bare
-- `REFERENCES business_parties(party_id)` would permit exactly the cross-tenant
-- reference the whole identity model exists to prevent, and the database is the
-- only place that can refuse it unconditionally.
ALTER TABLE build.tickets
  DROP CONSTRAINT IF EXISTS fk_tickets_customer_party_id;
ALTER TABLE build.tickets
  ADD CONSTRAINT fk_tickets_customer_party_id
  FOREIGN KEY (org_id, customer_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE build.tickets VALIDATE CONSTRAINT fk_tickets_customer_party_id;

CREATE INDEX IF NOT EXISTS idx_tickets_customer_party_id
  ON build.tickets (org_id, customer_party_id);

-- client_onboarding_items.client_id
ALTER TABLE client_onboarding_items ADD COLUMN IF NOT EXISTS client_party_id text;

UPDATE client_onboarding_items t
   SET client_party_id = m.party_id
  FROM client_party_map m
 WHERE m.client_id = t.client_id
   AND m.organization_id = t.org_id
   AND t.client_party_id IS NULL
   AND t.client_id IS NOT NULL;

-- Composite, so a row cannot point at another tenant's party. A bare
-- `REFERENCES business_parties(party_id)` would permit exactly the cross-tenant
-- reference the whole identity model exists to prevent, and the database is the
-- only place that can refuse it unconditionally.
ALTER TABLE client_onboarding_items
  DROP CONSTRAINT IF EXISTS fk_client_onboarding_items_client_party_id;
ALTER TABLE client_onboarding_items
  ADD CONSTRAINT fk_client_onboarding_items_client_party_id
  FOREIGN KEY (org_id, client_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE client_onboarding_items VALIDATE CONSTRAINT fk_client_onboarding_items_client_party_id;

CREATE INDEX IF NOT EXISTS idx_client_onboarding_items_client_party_id
  ON client_onboarding_items (org_id, client_party_id);

-- client_opportunities.client_id
ALTER TABLE client_opportunities ADD COLUMN IF NOT EXISTS client_party_id text;

UPDATE client_opportunities t
   SET client_party_id = m.party_id
  FROM client_party_map m
 WHERE m.client_id = t.client_id
   AND m.organization_id = t.org_id
   AND t.client_party_id IS NULL
   AND t.client_id IS NOT NULL;

-- Composite, so a row cannot point at another tenant's party. A bare
-- `REFERENCES business_parties(party_id)` would permit exactly the cross-tenant
-- reference the whole identity model exists to prevent, and the database is the
-- only place that can refuse it unconditionally.
ALTER TABLE client_opportunities
  DROP CONSTRAINT IF EXISTS fk_client_opportunities_client_party_id;
ALTER TABLE client_opportunities
  ADD CONSTRAINT fk_client_opportunities_client_party_id
  FOREIGN KEY (org_id, client_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE client_opportunities VALIDATE CONSTRAINT fk_client_opportunities_client_party_id;

CREATE INDEX IF NOT EXISTS idx_client_opportunities_client_party_id
  ON client_opportunities (org_id, client_party_id);

-- csat_surveys.client_id
ALTER TABLE csat_surveys ADD COLUMN IF NOT EXISTS client_party_id text;

UPDATE csat_surveys t
   SET client_party_id = m.party_id
  FROM client_party_map m
 WHERE m.client_id = t.client_id
   AND m.organization_id = t.org_id
   AND t.client_party_id IS NULL
   AND t.client_id IS NOT NULL;

-- Composite, so a row cannot point at another tenant's party. A bare
-- `REFERENCES business_parties(party_id)` would permit exactly the cross-tenant
-- reference the whole identity model exists to prevent, and the database is the
-- only place that can refuse it unconditionally.
ALTER TABLE csat_surveys
  DROP CONSTRAINT IF EXISTS fk_csat_surveys_client_party_id;
ALTER TABLE csat_surveys
  ADD CONSTRAINT fk_csat_surveys_client_party_id
  FOREIGN KEY (org_id, client_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE csat_surveys VALIDATE CONSTRAINT fk_csat_surveys_client_party_id;

CREATE INDEX IF NOT EXISTS idx_csat_surveys_client_party_id
  ON csat_surveys (org_id, client_party_id);

-- inv_sales_orders.client_id
ALTER TABLE inv_sales_orders ADD COLUMN IF NOT EXISTS client_party_id text;

UPDATE inv_sales_orders t
   SET client_party_id = m.party_id
  FROM client_party_map m
 WHERE m.client_id = t.client_id
   AND m.organization_id = t.org_id
   AND t.client_party_id IS NULL
   AND t.client_id IS NOT NULL;

-- Composite, so a row cannot point at another tenant's party. A bare
-- `REFERENCES business_parties(party_id)` would permit exactly the cross-tenant
-- reference the whole identity model exists to prevent, and the database is the
-- only place that can refuse it unconditionally.
ALTER TABLE inv_sales_orders
  DROP CONSTRAINT IF EXISTS fk_inv_sales_orders_client_party_id;
ALTER TABLE inv_sales_orders
  ADD CONSTRAINT fk_inv_sales_orders_client_party_id
  FOREIGN KEY (org_id, client_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE inv_sales_orders VALIDATE CONSTRAINT fk_inv_sales_orders_client_party_id;

CREATE INDEX IF NOT EXISTS idx_inv_sales_orders_client_party_id
  ON inv_sales_orders (org_id, client_party_id);

-- inv_vendors.client_id
ALTER TABLE inv_vendors ADD COLUMN IF NOT EXISTS client_party_id text;

UPDATE inv_vendors t
   SET client_party_id = m.party_id
  FROM client_party_map m
 WHERE m.client_id = t.client_id
   AND m.organization_id = t.org_id
   AND t.client_party_id IS NULL
   AND t.client_id IS NOT NULL;

-- Composite, so a row cannot point at another tenant's party. A bare
-- `REFERENCES business_parties(party_id)` would permit exactly the cross-tenant
-- reference the whole identity model exists to prevent, and the database is the
-- only place that can refuse it unconditionally.
ALTER TABLE inv_vendors
  DROP CONSTRAINT IF EXISTS fk_inv_vendors_client_party_id;
ALTER TABLE inv_vendors
  ADD CONSTRAINT fk_inv_vendors_client_party_id
  FOREIGN KEY (org_id, client_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE inv_vendors VALIDATE CONSTRAINT fk_inv_vendors_client_party_id;

CREATE INDEX IF NOT EXISTS idx_inv_vendors_client_party_id
  ON inv_vendors (org_id, client_party_id);

-- invoices.client_id
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS client_party_id text;

UPDATE invoices t
   SET client_party_id = m.party_id
  FROM client_party_map m
 WHERE m.client_id = t.client_id
   AND m.organization_id = t.org_id
   AND t.client_party_id IS NULL
   AND t.client_id IS NOT NULL;

-- Composite, so a row cannot point at another tenant's party. A bare
-- `REFERENCES business_parties(party_id)` would permit exactly the cross-tenant
-- reference the whole identity model exists to prevent, and the database is the
-- only place that can refuse it unconditionally.
ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS fk_invoices_client_party_id;
ALTER TABLE invoices
  ADD CONSTRAINT fk_invoices_client_party_id
  FOREIGN KEY (org_id, client_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE invoices VALIDATE CONSTRAINT fk_invoices_client_party_id;

CREATE INDEX IF NOT EXISTS idx_invoices_client_party_id
  ON invoices (org_id, client_party_id);

-- purchase_bills.vendor_id
ALTER TABLE purchase_bills ADD COLUMN IF NOT EXISTS vendor_party_id text;

UPDATE purchase_bills t
   SET vendor_party_id = m.party_id
  FROM client_party_map m
 WHERE m.client_id = t.vendor_id
   AND m.organization_id = t.org_id
   AND t.vendor_party_id IS NULL
   AND t.vendor_id IS NOT NULL;

-- Composite, so a row cannot point at another tenant's party. A bare
-- `REFERENCES business_parties(party_id)` would permit exactly the cross-tenant
-- reference the whole identity model exists to prevent, and the database is the
-- only place that can refuse it unconditionally.
ALTER TABLE purchase_bills
  DROP CONSTRAINT IF EXISTS fk_purchase_bills_vendor_party_id;
ALTER TABLE purchase_bills
  ADD CONSTRAINT fk_purchase_bills_vendor_party_id
  FOREIGN KEY (org_id, vendor_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE purchase_bills VALIDATE CONSTRAINT fk_purchase_bills_vendor_party_id;

CREATE INDEX IF NOT EXISTS idx_purchase_bills_vendor_party_id
  ON purchase_bills (org_id, vendor_party_id);

-- support_tickets.client_id
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS client_party_id text;

UPDATE support_tickets t
   SET client_party_id = m.party_id
  FROM client_party_map m
 WHERE m.client_id = t.client_id
   AND m.organization_id = t.org_id
   AND t.client_party_id IS NULL
   AND t.client_id IS NOT NULL;

-- Composite, so a row cannot point at another tenant's party. A bare
-- `REFERENCES business_parties(party_id)` would permit exactly the cross-tenant
-- reference the whole identity model exists to prevent, and the database is the
-- only place that can refuse it unconditionally.
ALTER TABLE support_tickets
  DROP CONSTRAINT IF EXISTS fk_support_tickets_client_party_id;
ALTER TABLE support_tickets
  ADD CONSTRAINT fk_support_tickets_client_party_id
  FOREIGN KEY (org_id, client_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE support_tickets VALIDATE CONSTRAINT fk_support_tickets_client_party_id;

CREATE INDEX IF NOT EXISTS idx_support_tickets_client_party_id
  ON support_tickets (org_id, client_party_id);

-- support_vip_clients.client_id
ALTER TABLE support_vip_clients ADD COLUMN IF NOT EXISTS client_party_id text;

UPDATE support_vip_clients t
   SET client_party_id = m.party_id
  FROM client_party_map m
 WHERE m.client_id = t.client_id
   AND m.organization_id = t.org_id
   AND t.client_party_id IS NULL
   AND t.client_id IS NOT NULL;

-- Composite, so a row cannot point at another tenant's party. A bare
-- `REFERENCES business_parties(party_id)` would permit exactly the cross-tenant
-- reference the whole identity model exists to prevent, and the database is the
-- only place that can refuse it unconditionally.
ALTER TABLE support_vip_clients
  DROP CONSTRAINT IF EXISTS fk_support_vip_clients_client_party_id;
ALTER TABLE support_vip_clients
  ADD CONSTRAINT fk_support_vip_clients_client_party_id
  FOREIGN KEY (org_id, client_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE support_vip_clients VALIDATE CONSTRAINT fk_support_vip_clients_client_party_id;

CREATE INDEX IF NOT EXISTS idx_support_vip_clients_client_party_id
  ON support_vip_clients (org_id, client_party_id);

-- timesheet_rates.client_id
ALTER TABLE timesheet_rates ADD COLUMN IF NOT EXISTS client_party_id text;

UPDATE timesheet_rates t
   SET client_party_id = m.party_id
  FROM client_party_map m
 WHERE m.client_id = t.client_id
   AND m.organization_id = t.org_id
   AND t.client_party_id IS NULL
   AND t.client_id IS NOT NULL;

-- Composite, so a row cannot point at another tenant's party. A bare
-- `REFERENCES business_parties(party_id)` would permit exactly the cross-tenant
-- reference the whole identity model exists to prevent, and the database is the
-- only place that can refuse it unconditionally.
ALTER TABLE timesheet_rates
  DROP CONSTRAINT IF EXISTS fk_timesheet_rates_client_party_id;
ALTER TABLE timesheet_rates
  ADD CONSTRAINT fk_timesheet_rates_client_party_id
  FOREIGN KEY (org_id, client_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE timesheet_rates VALIDATE CONSTRAINT fk_timesheet_rates_client_party_id;

CREATE INDEX IF NOT EXISTS idx_timesheet_rates_client_party_id
  ON timesheet_rates (org_id, client_party_id);
