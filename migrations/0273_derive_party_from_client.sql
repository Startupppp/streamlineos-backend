-- Custom SQL migration file, put your code below! --

-- The dual write, in the one place that cannot be forgotten.
--
-- Phase 2, ticket 08. The expand added a party column beside every `client_id`;
-- this keeps the two in step while readers migrate across.
--
-- A trigger rather than twelve edits to application code, and that is a
-- deliberate choice with a real trade-off. Against it: a trigger is invisible to
-- somebody reading the service that writes the row. For it, decisively:
--
--   **There are twelve insert sites in six modules**, and they are not the only
--   writers -- the importer, background jobs and raw SQL all reach these tables.
--   Dual-writing in application code would cover the paths somebody remembered.
--
--   **The thirteenth writer is the one that breaks it.** A column filled by
--   convention drifts the first time a new endpoint forgets, and the symptom is
--   a row that silently keeps no party -- invisible until the contract migration
--   tries to make the column NOT NULL and finds a decade of holes.
--
--   **Four of those six modules are being rewritten right now.** Editing them
--   mid-rewrite is how a merge nobody can review gets made.
--
-- `set_org_id_from_parent` in this same directory already establishes the
-- pattern: derive a column from a related row, in the database, on write.
--
-- This is expand-phase scaffolding and is **dropped by the contract migration**,
-- when `client_id` goes and the party column becomes the only truth.

SET lock_timeout = '5s';

/*
  Fills the party column from the client's map row.

  Reads the columns by name out of `to_jsonb(NEW)` rather than being written once
  per table, because eleven near-identical trigger functions is eleven places for
  one of them to be subtly different.

  Silent when there is nothing to do -- no legacy id, a party already set, or no
  map row yet. In particular a **missing map row is not an error**: a client
  created before the Party backfill reached it would otherwise fail its insert,
  and refusing to write an invoice because an identity migration is incomplete is
  a far worse outcome than an unfilled column the backfill will catch.
*/
CREATE OR REPLACE FUNCTION derive_party_from_client() RETURNS trigger AS $$
DECLARE
  legacy_col text := TG_ARGV[0];
  party_col  text := TG_ARGV[1];
  org_col    text := TG_ARGV[2];
  row_json   jsonb := to_jsonb(NEW);
  resolved   text;
BEGIN
  IF row_json ->> party_col IS NOT NULL THEN RETURN NEW; END IF;
  IF row_json ->> legacy_col IS NULL THEN RETURN NEW; END IF;

  SELECT m.party_id INTO resolved
    FROM client_party_map m
   WHERE m.client_id = (row_json ->> legacy_col)::int
     AND m.organization_id = row_json ->> org_col;

  IF resolved IS NULL THEN RETURN NEW; END IF;

  RETURN jsonb_populate_record(NEW, jsonb_build_object(party_col, resolved));
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tickets_party ON build.tickets;
CREATE TRIGGER trg_tickets_party
  BEFORE INSERT OR UPDATE OF customer_id ON build.tickets
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_client('customer_id', 'customer_party_id', 'org_id');

DROP TRIGGER IF EXISTS trg_client_onboarding_items_party ON client_onboarding_items;
CREATE TRIGGER trg_client_onboarding_items_party
  BEFORE INSERT OR UPDATE OF client_id ON client_onboarding_items
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_client('client_id', 'client_party_id', 'org_id');

DROP TRIGGER IF EXISTS trg_client_opportunities_party ON client_opportunities;
CREATE TRIGGER trg_client_opportunities_party
  BEFORE INSERT OR UPDATE OF client_id ON client_opportunities
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_client('client_id', 'client_party_id', 'org_id');

DROP TRIGGER IF EXISTS trg_csat_surveys_party ON csat_surveys;
CREATE TRIGGER trg_csat_surveys_party
  BEFORE INSERT OR UPDATE OF client_id ON csat_surveys
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_client('client_id', 'client_party_id', 'org_id');

DROP TRIGGER IF EXISTS trg_inv_sales_orders_party ON inv_sales_orders;
CREATE TRIGGER trg_inv_sales_orders_party
  BEFORE INSERT OR UPDATE OF client_id ON inv_sales_orders
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_client('client_id', 'client_party_id', 'org_id');

DROP TRIGGER IF EXISTS trg_inv_vendors_party ON inv_vendors;
CREATE TRIGGER trg_inv_vendors_party
  BEFORE INSERT OR UPDATE OF client_id ON inv_vendors
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_client('client_id', 'client_party_id', 'org_id');

DROP TRIGGER IF EXISTS trg_invoices_party ON invoices;
CREATE TRIGGER trg_invoices_party
  BEFORE INSERT OR UPDATE OF client_id ON invoices
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_client('client_id', 'client_party_id', 'org_id');

DROP TRIGGER IF EXISTS trg_purchase_bills_party ON purchase_bills;
CREATE TRIGGER trg_purchase_bills_party
  BEFORE INSERT OR UPDATE OF vendor_id ON purchase_bills
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_client('vendor_id', 'vendor_party_id', 'org_id');

DROP TRIGGER IF EXISTS trg_support_tickets_party ON support_tickets;
CREATE TRIGGER trg_support_tickets_party
  BEFORE INSERT OR UPDATE OF client_id ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_client('client_id', 'client_party_id', 'org_id');

DROP TRIGGER IF EXISTS trg_support_vip_clients_party ON support_vip_clients;
CREATE TRIGGER trg_support_vip_clients_party
  BEFORE INSERT OR UPDATE OF client_id ON support_vip_clients
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_client('client_id', 'client_party_id', 'org_id');

DROP TRIGGER IF EXISTS trg_timesheet_rates_party ON timesheet_rates;
CREATE TRIGGER trg_timesheet_rates_party
  BEFORE INSERT OR UPDATE OF client_id ON timesheet_rates
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_client('client_id', 'client_party_id', 'org_id');
