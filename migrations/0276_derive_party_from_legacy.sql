-- Custom SQL migration file, put your code below! --

-- The dual write for the other three legacy tables.
--
-- Phase 2, ticket 08. 0273 did this for `clients` with one generic function
-- reading its column names from `TG_ARGV`. The only thing that differs here is
-- which map table to look in, so the function takes that as a fourth argument
-- rather than being copied three more times -- nineteen near-identical trigger
-- functions is nineteen places for one of them to be subtly wrong.
--
-- `0273`'s function is superseded and dropped at the end: keeping a
-- `derive_party_from_client` beside a `derive_party_from_legacy` that does
-- strictly more would leave two answers to one question.
--
-- Expand-phase scaffolding. The contract migration drops all of it.

SET lock_timeout = '5s';

/*
  Fills a party column from whichever `*_party_map` the caller names.

  Dynamic SQL for the map table because it is a trigger argument. Safe here
  because every argument is written into this migration by hand -- none of it
  reaches the function from a request -- and `format(%I)` quotes it as an
  identifier regardless.
*/
CREATE OR REPLACE FUNCTION derive_party_from_legacy() RETURNS trigger AS $$
DECLARE
  legacy_col text := TG_ARGV[0];
  party_col  text := TG_ARGV[1];
  org_col    text := TG_ARGV[2];
  map_table  text := TG_ARGV[3];
  map_col    text := TG_ARGV[4];
  row_json   jsonb := to_jsonb(NEW);
  resolved   text;
BEGIN
  IF row_json ->> party_col IS NOT NULL THEN RETURN NEW; END IF;
  IF row_json ->> legacy_col IS NULL THEN RETURN NEW; END IF;

  EXECUTE format(
    'SELECT party_id FROM %I WHERE %I = $1 AND organization_id = $2',
    map_table, map_col
  )
  INTO resolved
  USING (row_json ->> legacy_col)::int, row_json ->> org_col;

  IF resolved IS NULL THEN RETURN NEW; END IF;

  RETURN jsonb_populate_record(NEW, jsonb_build_object(party_col, resolved));
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_calendar_events_lead_party ON calendar_events;
CREATE TRIGGER trg_calendar_events_lead_party
  BEFORE INSERT OR UPDATE OF linked_lead_id ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('linked_lead_id', 'linked_lead_party_id', 'org_id', 'lead_party_map', 'lead_id');

DROP TRIGGER IF EXISTS trg_client_accounts_lead_party ON client_accounts;
CREATE TRIGGER trg_client_accounts_lead_party
  BEFORE INSERT OR UPDATE OF lead_id ON client_accounts
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');

DROP TRIGGER IF EXISTS trg_crm_lead_touchpoints_lead_party ON crm_lead_touchpoints;
CREATE TRIGGER trg_crm_lead_touchpoints_lead_party
  BEFORE INSERT OR UPDATE OF lead_id ON crm_lead_touchpoints
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');

DROP TRIGGER IF EXISTS trg_deals_lead_party ON deals;
CREATE TRIGGER trg_deals_lead_party
  BEFORE INSERT OR UPDATE OF lead_id ON deals
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');

DROP TRIGGER IF EXISTS trg_lead_activities_lead_party ON lead_activities;
CREATE TRIGGER trg_lead_activities_lead_party
  BEFORE INSERT OR UPDATE OF lead_id ON lead_activities
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');

DROP TRIGGER IF EXISTS trg_lead_emails_lead_party ON lead_emails;
CREATE TRIGGER trg_lead_emails_lead_party
  BEFORE INSERT OR UPDATE OF lead_id ON lead_emails
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');

DROP TRIGGER IF EXISTS trg_lead_notes_lead_party ON lead_notes;
CREATE TRIGGER trg_lead_notes_lead_party
  BEFORE INSERT OR UPDATE OF lead_id ON lead_notes
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');

DROP TRIGGER IF EXISTS trg_lead_tasks_lead_party ON lead_tasks;
CREATE TRIGGER trg_lead_tasks_lead_party
  BEFORE INSERT OR UPDATE OF lead_id ON lead_tasks
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');

DROP TRIGGER IF EXISTS trg_survey_participants_lead_party ON survey_participants;
CREATE TRIGGER trg_survey_participants_lead_party
  BEFORE INSERT OR UPDATE OF lead_id ON survey_participants
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');

DROP TRIGGER IF EXISTS trg_feedback_posts_contact_party ON build.feedback_posts;
CREATE TRIGGER trg_feedback_posts_contact_party
  BEFORE INSERT OR UPDATE OF crm_contact_id ON build.feedback_posts
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('crm_contact_id', 'crm_contact_party_id', 'org_id', 'contact_party_map', 'contact_id');

DROP TRIGGER IF EXISTS trg_feedbucket_contact_party ON build.feedbucket_submissions;
CREATE TRIGGER trg_feedbucket_contact_party
  BEFORE INSERT OR UPDATE OF crm_contact_id ON build.feedbucket_submissions
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('crm_contact_id', 'crm_contact_party_id', 'org_id', 'contact_party_map', 'contact_id');

DROP TRIGGER IF EXISTS trg_contact_channel_consent_party ON crm_contact_channel_consent;
CREATE TRIGGER trg_contact_channel_consent_party
  BEFORE INSERT OR UPDATE OF contact_id ON crm_contact_channel_consent
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('contact_id', 'contact_party_id', 'org_id', 'contact_party_map', 'contact_id');

DROP TRIGGER IF EXISTS trg_contact_consent_events_party ON crm_contact_consent_events;
CREATE TRIGGER trg_contact_consent_events_party
  BEFORE INSERT OR UPDATE OF contact_id ON crm_contact_consent_events
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('contact_id', 'contact_party_id', 'org_id', 'contact_party_map', 'contact_id');

DROP TRIGGER IF EXISTS trg_contact_roles_party ON crm_contact_roles;
CREATE TRIGGER trg_contact_roles_party
  BEFORE INSERT OR UPDATE OF contact_id ON crm_contact_roles
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('contact_id', 'contact_party_id', 'org_id', 'contact_party_map', 'contact_id');

DROP TRIGGER IF EXISTS trg_deal_stakeholders_party ON crm_deal_stakeholders;
CREATE TRIGGER trg_deal_stakeholders_party
  BEFORE INSERT OR UPDATE OF contact_id ON crm_deal_stakeholders
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('contact_id', 'contact_party_id', 'org_id', 'contact_party_map', 'contact_id');

DROP TRIGGER IF EXISTS trg_survey_participants_contact_party ON survey_participants;
CREATE TRIGGER trg_survey_participants_contact_party
  BEFORE INSERT OR UPDATE OF contact_id ON survey_participants
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('contact_id', 'contact_party_id', 'org_id', 'contact_party_map', 'contact_id');

DROP TRIGGER IF EXISTS trg_feedback_posts_org_party ON build.feedback_posts;
CREATE TRIGGER trg_feedback_posts_org_party
  BEFORE INSERT OR UPDATE OF crm_organization_id ON build.feedback_posts
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('crm_organization_id', 'crm_organization_party_id', 'org_id', 'crm_org_party_map', 'crm_organization_id');

DROP TRIGGER IF EXISTS trg_feedbucket_org_party ON build.feedbucket_submissions;
CREATE TRIGGER trg_feedbucket_org_party
  BEFORE INSERT OR UPDATE OF crm_organization_id ON build.feedbucket_submissions
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('crm_organization_id', 'crm_organization_party_id', 'org_id', 'crm_org_party_map', 'crm_organization_id');

DROP TRIGGER IF EXISTS trg_tickets_org_party ON build.tickets;
CREATE TRIGGER trg_tickets_org_party
  BEFORE INSERT OR UPDATE OF customer_id ON build.tickets
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('customer_id', 'customer_org_party_id', 'org_id', 'crm_org_party_map', 'crm_organization_id');

-- The `clients` triggers move onto the general function.

DROP TRIGGER IF EXISTS trg_tickets_party ON build.tickets;
CREATE TRIGGER trg_tickets_party
  BEFORE INSERT OR UPDATE OF customer_id ON build.tickets
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('customer_id', 'customer_party_id', 'org_id', 'client_party_map', 'client_id');

DROP TRIGGER IF EXISTS trg_client_onboarding_items_party ON client_onboarding_items;
CREATE TRIGGER trg_client_onboarding_items_party
  BEFORE INSERT OR UPDATE OF client_id ON client_onboarding_items
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');

DROP TRIGGER IF EXISTS trg_client_opportunities_party ON client_opportunities;
CREATE TRIGGER trg_client_opportunities_party
  BEFORE INSERT OR UPDATE OF client_id ON client_opportunities
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');

DROP TRIGGER IF EXISTS trg_csat_surveys_party ON csat_surveys;
CREATE TRIGGER trg_csat_surveys_party
  BEFORE INSERT OR UPDATE OF client_id ON csat_surveys
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');

DROP TRIGGER IF EXISTS trg_inv_sales_orders_party ON inv_sales_orders;
CREATE TRIGGER trg_inv_sales_orders_party
  BEFORE INSERT OR UPDATE OF client_id ON inv_sales_orders
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');

DROP TRIGGER IF EXISTS trg_inv_vendors_party ON inv_vendors;
CREATE TRIGGER trg_inv_vendors_party
  BEFORE INSERT OR UPDATE OF client_id ON inv_vendors
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');

DROP TRIGGER IF EXISTS trg_invoices_party ON invoices;
CREATE TRIGGER trg_invoices_party
  BEFORE INSERT OR UPDATE OF client_id ON invoices
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');

DROP TRIGGER IF EXISTS trg_purchase_bills_party ON purchase_bills;
CREATE TRIGGER trg_purchase_bills_party
  BEFORE INSERT OR UPDATE OF vendor_id ON purchase_bills
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('vendor_id', 'vendor_party_id', 'org_id', 'client_party_map', 'client_id');

DROP TRIGGER IF EXISTS trg_support_tickets_party ON support_tickets;
CREATE TRIGGER trg_support_tickets_party
  BEFORE INSERT OR UPDATE OF client_id ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');

DROP TRIGGER IF EXISTS trg_support_vip_clients_party ON support_vip_clients;
CREATE TRIGGER trg_support_vip_clients_party
  BEFORE INSERT OR UPDATE OF client_id ON support_vip_clients
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');

DROP TRIGGER IF EXISTS trg_timesheet_rates_party ON timesheet_rates;
CREATE TRIGGER trg_timesheet_rates_party
  BEFORE INSERT OR UPDATE OF client_id ON timesheet_rates
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');

DROP TRIGGER IF EXISTS trg_inv_customer_returns_party ON inv_customer_returns;
CREATE TRIGGER trg_inv_customer_returns_party
  BEFORE INSERT OR UPDATE OF client_id ON inv_customer_returns
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');

DROP FUNCTION IF EXISTS derive_party_from_client();
