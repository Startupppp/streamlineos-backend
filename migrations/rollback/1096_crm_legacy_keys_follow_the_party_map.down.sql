-- Reverses 0916. Points the 23 keys back at `contacts`, `clients` and `leads`,
-- with the single-column keys restored beside the composite ones, exactly as
-- the catalogue had them.
--
-- Read this before running it: the rollback restores a known breakage. The
-- legacy tables are not written (0277, 0913), so with these keys back every
-- consent record, contact role, deal stakeholder, deal, timesheet rate or
-- support ticket that names a record created since fails its foreign key.
--
-- The legacy keys are added NOT VALID and never validated. Rows written since
-- 0916 may name map-minted ids that have no legacy row, so a validating ADD
-- would fail on existing data and the rollback could not run. Every ADD follows
-- a DROP IF EXISTS.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "crm_contact_roles" DROP CONSTRAINT IF EXISTS "fk_crm_contact_roles_contact_id_org";
--> statement-breakpoint
ALTER TABLE "crm_contact_roles" DROP CONSTRAINT IF EXISTS "crm_contact_roles_contact_id_contacts_id_fk";
--> statement-breakpoint
ALTER TABLE "crm_contact_roles" ADD CONSTRAINT "crm_contact_roles_contact_id_contacts_id_fk"
  FOREIGN KEY (contact_id) REFERENCES "public"."contacts"(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_contact_roles" ADD CONSTRAINT "fk_crm_contact_roles_contact_id_org"
  FOREIGN KEY (org_id, contact_id) REFERENCES "public"."contacts"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_deal_stakeholders" DROP CONSTRAINT IF EXISTS "fk_crm_deal_stakeholders_contact_id_org";
--> statement-breakpoint
ALTER TABLE "crm_deal_stakeholders" DROP CONSTRAINT IF EXISTS "crm_deal_stakeholders_contact_id_contacts_id_fk";
--> statement-breakpoint
ALTER TABLE "crm_deal_stakeholders" ADD CONSTRAINT "crm_deal_stakeholders_contact_id_contacts_id_fk"
  FOREIGN KEY (contact_id) REFERENCES "public"."contacts"(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_deal_stakeholders" ADD CONSTRAINT "fk_crm_deal_stakeholders_contact_id_org"
  FOREIGN KEY (org_id, contact_id) REFERENCES "public"."contacts"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_contact_channel_consent" DROP CONSTRAINT IF EXISTS "fk_crm_contact_channel_consent_contact_id_org";
--> statement-breakpoint
ALTER TABLE "crm_contact_channel_consent" DROP CONSTRAINT IF EXISTS "crm_contact_channel_consent_contact_id_contacts_id_fk";
--> statement-breakpoint
ALTER TABLE "crm_contact_channel_consent" ADD CONSTRAINT "crm_contact_channel_consent_contact_id_contacts_id_fk"
  FOREIGN KEY (contact_id) REFERENCES "public"."contacts"(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_contact_consent_events" DROP CONSTRAINT IF EXISTS "fk_crm_contact_consent_events_contact_id_org";
--> statement-breakpoint
ALTER TABLE "crm_contact_consent_events" DROP CONSTRAINT IF EXISTS "crm_contact_consent_events_contact_id_contacts_id_fk";
--> statement-breakpoint
ALTER TABLE "crm_contact_consent_events" ADD CONSTRAINT "crm_contact_consent_events_contact_id_contacts_id_fk"
  FOREIGN KEY (contact_id) REFERENCES "public"."contacts"(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "survey_participants" DROP CONSTRAINT IF EXISTS "fk_survey_participants_contact_id_org";
--> statement-breakpoint
ALTER TABLE "survey_participants" DROP CONSTRAINT IF EXISTS "survey_participants_contact_id_contacts_id_fk";
--> statement-breakpoint
ALTER TABLE "survey_participants" ADD CONSTRAINT "survey_participants_contact_id_contacts_id_fk"
  FOREIGN KEY (contact_id) REFERENCES "public"."contacts"(id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "survey_participants" ADD CONSTRAINT "fk_survey_participants_contact_id_org"
  FOREIGN KEY (org_id, contact_id) REFERENCES "public"."contacts"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "fk_deals_client_id_org";
--> statement-breakpoint
ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "deals_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_client_id_clients_id_fk"
  FOREIGN KEY (client_id) REFERENCES "public"."clients"(id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "fk_deals_client_id_org"
  FOREIGN KEY (org_id, client_id) REFERENCES "public"."clients"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "fk_invoices_client_id_org";
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk"
  FOREIGN KEY (client_id) REFERENCES "public"."clients"(id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "fk_invoices_client_id_org"
  FOREIGN KEY (org_id, client_id) REFERENCES "public"."clients"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "purchase_bills" DROP CONSTRAINT IF EXISTS "fk_purchase_bills_vendor_id_org";
--> statement-breakpoint
ALTER TABLE "purchase_bills" DROP CONSTRAINT IF EXISTS "purchase_bills_vendor_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_vendor_id_clients_id_fk"
  FOREIGN KEY (vendor_id) REFERENCES "public"."clients"(id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "fk_purchase_bills_vendor_id_org"
  FOREIGN KEY (org_id, vendor_id) REFERENCES "public"."clients"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "client_onboarding_items" DROP CONSTRAINT IF EXISTS "fk_client_onboarding_items_client_id_org";
--> statement-breakpoint
ALTER TABLE "client_onboarding_items" DROP CONSTRAINT IF EXISTS "client_onboarding_items_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "client_onboarding_items" ADD CONSTRAINT "client_onboarding_items_client_id_clients_id_fk"
  FOREIGN KEY (client_id) REFERENCES "public"."clients"(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "client_onboarding_items" ADD CONSTRAINT "fk_client_onboarding_items_client_id_org"
  FOREIGN KEY (org_id, client_id) REFERENCES "public"."clients"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "client_opportunities" DROP CONSTRAINT IF EXISTS "fk_client_opportunities_client_id_org";
--> statement-breakpoint
ALTER TABLE "client_opportunities" DROP CONSTRAINT IF EXISTS "client_opportunities_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "client_opportunities" ADD CONSTRAINT "client_opportunities_client_id_clients_id_fk"
  FOREIGN KEY (client_id) REFERENCES "public"."clients"(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "client_opportunities" ADD CONSTRAINT "fk_client_opportunities_client_id_org"
  FOREIGN KEY (org_id, client_id) REFERENCES "public"."clients"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "csat_surveys" DROP CONSTRAINT IF EXISTS "fk_csat_surveys_client_id_org";
--> statement-breakpoint
ALTER TABLE "csat_surveys" DROP CONSTRAINT IF EXISTS "csat_surveys_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_client_id_clients_id_fk"
  FOREIGN KEY (client_id) REFERENCES "public"."clients"(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "fk_csat_surveys_client_id_org"
  FOREIGN KEY (org_id, client_id) REFERENCES "public"."clients"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "fk_support_tickets_client_id_org";
--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_client_id_clients_id_fk"
  FOREIGN KEY (client_id) REFERENCES "public"."clients"(id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "fk_support_tickets_client_id_org"
  FOREIGN KEY (org_id, client_id) REFERENCES "public"."clients"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "support_vip_clients" DROP CONSTRAINT IF EXISTS "fk_support_vip_clients_client_id_org";
--> statement-breakpoint
ALTER TABLE "support_vip_clients" DROP CONSTRAINT IF EXISTS "support_vip_clients_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "support_vip_clients" ADD CONSTRAINT "support_vip_clients_client_id_clients_id_fk"
  FOREIGN KEY (client_id) REFERENCES "public"."clients"(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "support_vip_clients" ADD CONSTRAINT "fk_support_vip_clients_client_id_org"
  FOREIGN KEY (org_id, client_id) REFERENCES "public"."clients"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "timesheet_rates" DROP CONSTRAINT IF EXISTS "fk_timesheet_rates_client_id_org";
--> statement-breakpoint
ALTER TABLE "timesheet_rates" DROP CONSTRAINT IF EXISTS "fk_timesheet_rates_client";
--> statement-breakpoint
ALTER TABLE "timesheet_rates" ADD CONSTRAINT "fk_timesheet_rates_client"
  FOREIGN KEY (client_id) REFERENCES "public"."clients"(id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "fk_deals_lead_id_org";
--> statement-breakpoint
ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "deals_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_lead_id_leads_id_fk"
  FOREIGN KEY (lead_id) REFERENCES "public"."leads"(id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "fk_deals_lead_id_org"
  FOREIGN KEY (org_id, lead_id) REFERENCES "public"."leads"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_lead_touchpoints" DROP CONSTRAINT IF EXISTS "fk_crm_lead_touchpoints_lead_id_org";
--> statement-breakpoint
ALTER TABLE "crm_lead_touchpoints" DROP CONSTRAINT IF EXISTS "crm_lead_touchpoints_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "crm_lead_touchpoints" ADD CONSTRAINT "crm_lead_touchpoints_lead_id_leads_id_fk"
  FOREIGN KEY (lead_id) REFERENCES "public"."leads"(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_lead_touchpoints" ADD CONSTRAINT "fk_crm_lead_touchpoints_lead_id_org"
  FOREIGN KEY (org_id, lead_id) REFERENCES "public"."leads"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "client_accounts" DROP CONSTRAINT IF EXISTS "fk_client_accounts_lead_id_org";
--> statement-breakpoint
ALTER TABLE "client_accounts" DROP CONSTRAINT IF EXISTS "client_accounts_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "client_accounts" ADD CONSTRAINT "client_accounts_lead_id_leads_id_fk"
  FOREIGN KEY (lead_id) REFERENCES "public"."leads"(id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "client_accounts" ADD CONSTRAINT "fk_client_accounts_lead_id_org"
  FOREIGN KEY (org_id, lead_id) REFERENCES "public"."leads"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "lead_activities" DROP CONSTRAINT IF EXISTS "fk_lead_activities_lead_id_org";
--> statement-breakpoint
ALTER TABLE "lead_activities" DROP CONSTRAINT IF EXISTS "lead_activities_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_leads_id_fk"
  FOREIGN KEY (lead_id) REFERENCES "public"."leads"(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "fk_lead_activities_lead_id_org"
  FOREIGN KEY (org_id, lead_id) REFERENCES "public"."leads"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "lead_emails" DROP CONSTRAINT IF EXISTS "fk_lead_emails_lead_id_org";
--> statement-breakpoint
ALTER TABLE "lead_emails" DROP CONSTRAINT IF EXISTS "lead_emails_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "lead_emails" ADD CONSTRAINT "lead_emails_lead_id_leads_id_fk"
  FOREIGN KEY (lead_id) REFERENCES "public"."leads"(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "lead_emails" ADD CONSTRAINT "fk_lead_emails_lead_id_org"
  FOREIGN KEY (org_id, lead_id) REFERENCES "public"."leads"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "lead_notes" DROP CONSTRAINT IF EXISTS "fk_lead_notes_lead_id_org";
--> statement-breakpoint
ALTER TABLE "lead_notes" DROP CONSTRAINT IF EXISTS "lead_notes_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_lead_id_leads_id_fk"
  FOREIGN KEY (lead_id) REFERENCES "public"."leads"(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "fk_lead_notes_lead_id_org"
  FOREIGN KEY (org_id, lead_id) REFERENCES "public"."leads"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "lead_tasks" DROP CONSTRAINT IF EXISTS "fk_lead_tasks_lead_id_org";
--> statement-breakpoint
ALTER TABLE "lead_tasks" DROP CONSTRAINT IF EXISTS "lead_tasks_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "lead_tasks" ADD CONSTRAINT "lead_tasks_lead_id_leads_id_fk"
  FOREIGN KEY (lead_id) REFERENCES "public"."leads"(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "lead_tasks" ADD CONSTRAINT "fk_lead_tasks_lead_id_org"
  FOREIGN KEY (org_id, lead_id) REFERENCES "public"."leads"(org_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "calendar_events" DROP CONSTRAINT IF EXISTS "fk_calendar_events_linked_lead_id_org";
--> statement-breakpoint
ALTER TABLE "calendar_events" DROP CONSTRAINT IF EXISTS "fk_calendar_events_linked_lead";
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "fk_calendar_events_linked_lead"
  FOREIGN KEY (linked_lead_id) REFERENCES "public"."leads"(id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "survey_participants" DROP CONSTRAINT IF EXISTS "fk_survey_participants_lead_id_org";
--> statement-breakpoint
ALTER TABLE "survey_participants" DROP CONSTRAINT IF EXISTS "survey_participants_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "survey_participants" ADD CONSTRAINT "survey_participants_lead_id_leads_id_fk"
  FOREIGN KEY (lead_id) REFERENCES "public"."leads"(id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "survey_participants" ADD CONSTRAINT "fk_survey_participants_lead_id_org"
  FOREIGN KEY (org_id, lead_id) REFERENCES "public"."leads"(org_id, id) NOT VALID;
