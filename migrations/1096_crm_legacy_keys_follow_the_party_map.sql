-- 0916 — CRM's legacy keys point at the party maps, not at the legacy tables
-- =============================================================================
-- 0915 moved inventory's customer keys onto `client_party_map`. This is the same
-- fix for every other table that still keyed a legacy id to `contacts`,
-- `clients` or `leads`.
--
-- The Party migration stopped writing those three tables (0277, ticket 08): a
-- contact, client or lead created today gets its legacy id from its
-- `*_party_map` row, and no legacy row is ever inserted. 0913 dropped the three
-- keys that tied each map back to its legacy table, because the map could not
-- satisfy them. The keys pointing INTO the legacy tables from everywhere else
-- stayed, and each one refuses the id of any record created since. Measured on
-- a database built from this branch: every consent write for a new contact
-- failed `crm_contact_channel_consent_contact_id_contacts_id_fk` (SQLSTATE
-- 23503), so recording an opt-in, an opt-out or a one-click unsubscribe
-- returned 500. Contact roles, deal stakeholders, a deal's client or lead,
-- timesheet rates, support tickets, invoices and the rest fail the same way.
--
-- The CRM lane never saw this, because 0278 dropped the legacy tables there,
-- and dropping them drops every key into them. On this branch 0278 runs only
-- under `app.allow_legacy_identity_drop`, so the tables and their keys stay. If
-- 0278 runs later, its loop drops only keys whose target is a legacy table, so
-- the keys below survive it.
--
-- Each key moves to its map, still composite on the tenant, and keeps the
-- delete action its single-column key had. The map row stands in for the
-- legacy row, so deleting it (a party's DPDP erasure cascades to its maps) does
-- what deleting the legacy row did. SET NULL takes Postgres 15's column-list
-- form, so it clears the pointer and never the tenant. The bare single-column
-- keys go, as in 0915: they were never tenant-safe.
--
-- Left alone:
--   - the legacy tables' keys between each other (contacts → leads,
--     clients → leads, leads.merged_into_id and so on). They go with 0278.
--   - build.tickets, build.feedback_posts and build.feedbucket_submissions.
--     They carry the same defect, but PMS/Build is owned elsewhere.
--   - crm_organizations, which nothing outside those two groups references.
--
-- timesheet_rates.client_id and calendar_events.linked_lead_id have no index
-- behind the new key, and had none behind the old one either.
--
-- A pre-check refuses before any DDL if a row names a legacy id its map does
-- not hold. Validating would fail on that row anyway, with a less useful
-- message. Each ADD follows a DROP IF EXISTS, so a re-run is a no-op, and each
-- is added NOT VALID and then validated.

SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DO $$
DECLARE
  stranded text;
BEGIN
  SELECT string_agg(format('%s: %s', col, n), ', ') INTO stranded FROM (
    SELECT 'crm_contact_roles.contact_id' AS col, count(*) AS n FROM "crm_contact_roles" x
     WHERE x."contact_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "contact_party_map" m WHERE m.organization_id = x.org_id AND m."contact_id" = x."contact_id")
    UNION ALL
    SELECT 'crm_deal_stakeholders.contact_id' AS col, count(*) AS n FROM "crm_deal_stakeholders" x
     WHERE x."contact_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "contact_party_map" m WHERE m.organization_id = x.org_id AND m."contact_id" = x."contact_id")
    UNION ALL
    SELECT 'crm_contact_channel_consent.contact_id' AS col, count(*) AS n FROM "crm_contact_channel_consent" x
     WHERE x."contact_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "contact_party_map" m WHERE m.organization_id = x.org_id AND m."contact_id" = x."contact_id")
    UNION ALL
    SELECT 'crm_contact_consent_events.contact_id' AS col, count(*) AS n FROM "crm_contact_consent_events" x
     WHERE x."contact_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "contact_party_map" m WHERE m.organization_id = x.org_id AND m."contact_id" = x."contact_id")
    UNION ALL
    SELECT 'survey_participants.contact_id' AS col, count(*) AS n FROM "survey_participants" x
     WHERE x."contact_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "contact_party_map" m WHERE m.organization_id = x.org_id AND m."contact_id" = x."contact_id")
    UNION ALL
    SELECT 'deals.client_id' AS col, count(*) AS n FROM "deals" x
     WHERE x."client_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "client_party_map" m WHERE m.organization_id = x.org_id AND m."client_id" = x."client_id")
    UNION ALL
    SELECT 'invoices.client_id' AS col, count(*) AS n FROM "invoices" x
     WHERE x."client_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "client_party_map" m WHERE m.organization_id = x.org_id AND m."client_id" = x."client_id")
    UNION ALL
    SELECT 'purchase_bills.vendor_id' AS col, count(*) AS n FROM "purchase_bills" x
     WHERE x."vendor_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "client_party_map" m WHERE m.organization_id = x.org_id AND m."client_id" = x."vendor_id")
    UNION ALL
    SELECT 'client_onboarding_items.client_id' AS col, count(*) AS n FROM "client_onboarding_items" x
     WHERE x."client_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "client_party_map" m WHERE m.organization_id = x.org_id AND m."client_id" = x."client_id")
    UNION ALL
    SELECT 'client_opportunities.client_id' AS col, count(*) AS n FROM "client_opportunities" x
     WHERE x."client_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "client_party_map" m WHERE m.organization_id = x.org_id AND m."client_id" = x."client_id")
    UNION ALL
    SELECT 'csat_surveys.client_id' AS col, count(*) AS n FROM "csat_surveys" x
     WHERE x."client_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "client_party_map" m WHERE m.organization_id = x.org_id AND m."client_id" = x."client_id")
    UNION ALL
    SELECT 'support_tickets.client_id' AS col, count(*) AS n FROM "support_tickets" x
     WHERE x."client_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "client_party_map" m WHERE m.organization_id = x.org_id AND m."client_id" = x."client_id")
    UNION ALL
    SELECT 'support_vip_clients.client_id' AS col, count(*) AS n FROM "support_vip_clients" x
     WHERE x."client_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "client_party_map" m WHERE m.organization_id = x.org_id AND m."client_id" = x."client_id")
    UNION ALL
    SELECT 'timesheet_rates.client_id' AS col, count(*) AS n FROM "timesheet_rates" x
     WHERE x."client_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "client_party_map" m WHERE m.organization_id = x.org_id AND m."client_id" = x."client_id")
    UNION ALL
    SELECT 'deals.lead_id' AS col, count(*) AS n FROM "deals" x
     WHERE x."lead_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "lead_party_map" m WHERE m.organization_id = x.org_id AND m."lead_id" = x."lead_id")
    UNION ALL
    SELECT 'crm_lead_touchpoints.lead_id' AS col, count(*) AS n FROM "crm_lead_touchpoints" x
     WHERE x."lead_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "lead_party_map" m WHERE m.organization_id = x.org_id AND m."lead_id" = x."lead_id")
    UNION ALL
    SELECT 'client_accounts.lead_id' AS col, count(*) AS n FROM "client_accounts" x
     WHERE x."lead_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "lead_party_map" m WHERE m.organization_id = x.org_id AND m."lead_id" = x."lead_id")
    UNION ALL
    SELECT 'lead_activities.lead_id' AS col, count(*) AS n FROM "lead_activities" x
     WHERE x."lead_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "lead_party_map" m WHERE m.organization_id = x.org_id AND m."lead_id" = x."lead_id")
    UNION ALL
    SELECT 'lead_emails.lead_id' AS col, count(*) AS n FROM "lead_emails" x
     WHERE x."lead_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "lead_party_map" m WHERE m.organization_id = x.org_id AND m."lead_id" = x."lead_id")
    UNION ALL
    SELECT 'lead_notes.lead_id' AS col, count(*) AS n FROM "lead_notes" x
     WHERE x."lead_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "lead_party_map" m WHERE m.organization_id = x.org_id AND m."lead_id" = x."lead_id")
    UNION ALL
    SELECT 'lead_tasks.lead_id' AS col, count(*) AS n FROM "lead_tasks" x
     WHERE x."lead_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "lead_party_map" m WHERE m.organization_id = x.org_id AND m."lead_id" = x."lead_id")
    UNION ALL
    SELECT 'calendar_events.linked_lead_id' AS col, count(*) AS n FROM "calendar_events" x
     WHERE x."linked_lead_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "lead_party_map" m WHERE m.organization_id = x.org_id AND m."lead_id" = x."linked_lead_id")
    UNION ALL
    SELECT 'survey_participants.lead_id' AS col, count(*) AS n FROM "survey_participants" x
     WHERE x."lead_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "lead_party_map" m WHERE m.organization_id = x.org_id AND m."lead_id" = x."lead_id")
  ) s WHERE n > 0;
  IF stranded IS NOT NULL THEN
    RAISE EXCEPTION '0916: refusing to repoint. These rows name a legacy id the party map does not hold (%). Backfill the map before running this.', stranded;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "crm_contact_roles" DROP CONSTRAINT IF EXISTS "crm_contact_roles_contact_id_contacts_id_fk";
--> statement-breakpoint
ALTER TABLE "crm_contact_roles" DROP CONSTRAINT IF EXISTS "fk_crm_contact_roles_contact_id_org";
--> statement-breakpoint
ALTER TABLE "crm_contact_roles" ADD CONSTRAINT "fk_crm_contact_roles_contact_id_org"
  FOREIGN KEY ("org_id", "contact_id") REFERENCES "public"."contact_party_map"("organization_id", "contact_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_contact_roles" VALIDATE CONSTRAINT "fk_crm_contact_roles_contact_id_org";
--> statement-breakpoint

ALTER TABLE "crm_deal_stakeholders" DROP CONSTRAINT IF EXISTS "crm_deal_stakeholders_contact_id_contacts_id_fk";
--> statement-breakpoint
ALTER TABLE "crm_deal_stakeholders" DROP CONSTRAINT IF EXISTS "fk_crm_deal_stakeholders_contact_id_org";
--> statement-breakpoint
ALTER TABLE "crm_deal_stakeholders" ADD CONSTRAINT "fk_crm_deal_stakeholders_contact_id_org"
  FOREIGN KEY ("org_id", "contact_id") REFERENCES "public"."contact_party_map"("organization_id", "contact_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_deal_stakeholders" VALIDATE CONSTRAINT "fk_crm_deal_stakeholders_contact_id_org";
--> statement-breakpoint

ALTER TABLE "crm_contact_channel_consent" DROP CONSTRAINT IF EXISTS "crm_contact_channel_consent_contact_id_contacts_id_fk";
--> statement-breakpoint
ALTER TABLE "crm_contact_channel_consent" DROP CONSTRAINT IF EXISTS "fk_crm_contact_channel_consent_contact_id_org";
--> statement-breakpoint
ALTER TABLE "crm_contact_channel_consent" ADD CONSTRAINT "fk_crm_contact_channel_consent_contact_id_org"
  FOREIGN KEY ("org_id", "contact_id") REFERENCES "public"."contact_party_map"("organization_id", "contact_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_contact_channel_consent" VALIDATE CONSTRAINT "fk_crm_contact_channel_consent_contact_id_org";
--> statement-breakpoint

ALTER TABLE "crm_contact_consent_events" DROP CONSTRAINT IF EXISTS "crm_contact_consent_events_contact_id_contacts_id_fk";
--> statement-breakpoint
ALTER TABLE "crm_contact_consent_events" DROP CONSTRAINT IF EXISTS "fk_crm_contact_consent_events_contact_id_org";
--> statement-breakpoint
ALTER TABLE "crm_contact_consent_events" ADD CONSTRAINT "fk_crm_contact_consent_events_contact_id_org"
  FOREIGN KEY ("org_id", "contact_id") REFERENCES "public"."contact_party_map"("organization_id", "contact_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_contact_consent_events" VALIDATE CONSTRAINT "fk_crm_contact_consent_events_contact_id_org";
--> statement-breakpoint

ALTER TABLE "survey_participants" DROP CONSTRAINT IF EXISTS "survey_participants_contact_id_contacts_id_fk";
--> statement-breakpoint
ALTER TABLE "survey_participants" DROP CONSTRAINT IF EXISTS "fk_survey_participants_contact_id_org";
--> statement-breakpoint
ALTER TABLE "survey_participants" ADD CONSTRAINT "fk_survey_participants_contact_id_org"
  FOREIGN KEY ("org_id", "contact_id") REFERENCES "public"."contact_party_map"("organization_id", "contact_id") ON DELETE SET NULL ("contact_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "survey_participants" VALIDATE CONSTRAINT "fk_survey_participants_contact_id_org";
--> statement-breakpoint

ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "deals_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "fk_deals_client_id_org";
--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "fk_deals_client_id_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."client_party_map"("organization_id", "client_id") ON DELETE SET NULL ("client_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "deals" VALIDATE CONSTRAINT "fk_deals_client_id_org";
--> statement-breakpoint

ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "fk_invoices_client_id_org";
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "fk_invoices_client_id_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."client_party_map"("organization_id", "client_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "invoices" VALIDATE CONSTRAINT "fk_invoices_client_id_org";
--> statement-breakpoint

ALTER TABLE "purchase_bills" DROP CONSTRAINT IF EXISTS "purchase_bills_vendor_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "purchase_bills" DROP CONSTRAINT IF EXISTS "fk_purchase_bills_vendor_id_org";
--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "fk_purchase_bills_vendor_id_org"
  FOREIGN KEY ("org_id", "vendor_id") REFERENCES "public"."client_party_map"("organization_id", "client_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "purchase_bills" VALIDATE CONSTRAINT "fk_purchase_bills_vendor_id_org";
--> statement-breakpoint

ALTER TABLE "client_onboarding_items" DROP CONSTRAINT IF EXISTS "client_onboarding_items_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "client_onboarding_items" DROP CONSTRAINT IF EXISTS "fk_client_onboarding_items_client_id_org";
--> statement-breakpoint
ALTER TABLE "client_onboarding_items" ADD CONSTRAINT "fk_client_onboarding_items_client_id_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."client_party_map"("organization_id", "client_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "client_onboarding_items" VALIDATE CONSTRAINT "fk_client_onboarding_items_client_id_org";
--> statement-breakpoint

ALTER TABLE "client_opportunities" DROP CONSTRAINT IF EXISTS "client_opportunities_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "client_opportunities" DROP CONSTRAINT IF EXISTS "fk_client_opportunities_client_id_org";
--> statement-breakpoint
ALTER TABLE "client_opportunities" ADD CONSTRAINT "fk_client_opportunities_client_id_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."client_party_map"("organization_id", "client_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "client_opportunities" VALIDATE CONSTRAINT "fk_client_opportunities_client_id_org";
--> statement-breakpoint

ALTER TABLE "csat_surveys" DROP CONSTRAINT IF EXISTS "csat_surveys_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "csat_surveys" DROP CONSTRAINT IF EXISTS "fk_csat_surveys_client_id_org";
--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "fk_csat_surveys_client_id_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."client_party_map"("organization_id", "client_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "csat_surveys" VALIDATE CONSTRAINT "fk_csat_surveys_client_id_org";
--> statement-breakpoint

ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "fk_support_tickets_client_id_org";
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "fk_support_tickets_client_id_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."client_party_map"("organization_id", "client_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "support_tickets" VALIDATE CONSTRAINT "fk_support_tickets_client_id_org";
--> statement-breakpoint

ALTER TABLE "support_vip_clients" DROP CONSTRAINT IF EXISTS "support_vip_clients_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "support_vip_clients" DROP CONSTRAINT IF EXISTS "fk_support_vip_clients_client_id_org";
--> statement-breakpoint
ALTER TABLE "support_vip_clients" ADD CONSTRAINT "fk_support_vip_clients_client_id_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."client_party_map"("organization_id", "client_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "support_vip_clients" VALIDATE CONSTRAINT "fk_support_vip_clients_client_id_org";
--> statement-breakpoint

ALTER TABLE "timesheet_rates" DROP CONSTRAINT IF EXISTS "fk_timesheet_rates_client";
--> statement-breakpoint
ALTER TABLE "timesheet_rates" DROP CONSTRAINT IF EXISTS "fk_timesheet_rates_client_id_org";
--> statement-breakpoint
ALTER TABLE "timesheet_rates" ADD CONSTRAINT "fk_timesheet_rates_client_id_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."client_party_map"("organization_id", "client_id") ON DELETE SET NULL ("client_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "timesheet_rates" VALIDATE CONSTRAINT "fk_timesheet_rates_client_id_org";
--> statement-breakpoint

ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "deals_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "fk_deals_lead_id_org";
--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "fk_deals_lead_id_org"
  FOREIGN KEY ("org_id", "lead_id") REFERENCES "public"."lead_party_map"("organization_id", "lead_id") ON DELETE SET NULL ("lead_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "deals" VALIDATE CONSTRAINT "fk_deals_lead_id_org";
--> statement-breakpoint

ALTER TABLE "crm_lead_touchpoints" DROP CONSTRAINT IF EXISTS "crm_lead_touchpoints_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "crm_lead_touchpoints" DROP CONSTRAINT IF EXISTS "fk_crm_lead_touchpoints_lead_id_org";
--> statement-breakpoint
ALTER TABLE "crm_lead_touchpoints" ADD CONSTRAINT "fk_crm_lead_touchpoints_lead_id_org"
  FOREIGN KEY ("org_id", "lead_id") REFERENCES "public"."lead_party_map"("organization_id", "lead_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_lead_touchpoints" VALIDATE CONSTRAINT "fk_crm_lead_touchpoints_lead_id_org";
--> statement-breakpoint

ALTER TABLE "client_accounts" DROP CONSTRAINT IF EXISTS "client_accounts_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "client_accounts" DROP CONSTRAINT IF EXISTS "fk_client_accounts_lead_id_org";
--> statement-breakpoint
ALTER TABLE "client_accounts" ADD CONSTRAINT "fk_client_accounts_lead_id_org"
  FOREIGN KEY ("org_id", "lead_id") REFERENCES "public"."lead_party_map"("organization_id", "lead_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "client_accounts" VALIDATE CONSTRAINT "fk_client_accounts_lead_id_org";
--> statement-breakpoint

ALTER TABLE "lead_activities" DROP CONSTRAINT IF EXISTS "lead_activities_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "lead_activities" DROP CONSTRAINT IF EXISTS "fk_lead_activities_lead_id_org";
--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "fk_lead_activities_lead_id_org"
  FOREIGN KEY ("org_id", "lead_id") REFERENCES "public"."lead_party_map"("organization_id", "lead_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "lead_activities" VALIDATE CONSTRAINT "fk_lead_activities_lead_id_org";
--> statement-breakpoint

ALTER TABLE "lead_emails" DROP CONSTRAINT IF EXISTS "lead_emails_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "lead_emails" DROP CONSTRAINT IF EXISTS "fk_lead_emails_lead_id_org";
--> statement-breakpoint
ALTER TABLE "lead_emails" ADD CONSTRAINT "fk_lead_emails_lead_id_org"
  FOREIGN KEY ("org_id", "lead_id") REFERENCES "public"."lead_party_map"("organization_id", "lead_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "lead_emails" VALIDATE CONSTRAINT "fk_lead_emails_lead_id_org";
--> statement-breakpoint

ALTER TABLE "lead_notes" DROP CONSTRAINT IF EXISTS "lead_notes_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "lead_notes" DROP CONSTRAINT IF EXISTS "fk_lead_notes_lead_id_org";
--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "fk_lead_notes_lead_id_org"
  FOREIGN KEY ("org_id", "lead_id") REFERENCES "public"."lead_party_map"("organization_id", "lead_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "lead_notes" VALIDATE CONSTRAINT "fk_lead_notes_lead_id_org";
--> statement-breakpoint

ALTER TABLE "lead_tasks" DROP CONSTRAINT IF EXISTS "lead_tasks_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "lead_tasks" DROP CONSTRAINT IF EXISTS "fk_lead_tasks_lead_id_org";
--> statement-breakpoint
ALTER TABLE "lead_tasks" ADD CONSTRAINT "fk_lead_tasks_lead_id_org"
  FOREIGN KEY ("org_id", "lead_id") REFERENCES "public"."lead_party_map"("organization_id", "lead_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "lead_tasks" VALIDATE CONSTRAINT "fk_lead_tasks_lead_id_org";
--> statement-breakpoint

ALTER TABLE "calendar_events" DROP CONSTRAINT IF EXISTS "fk_calendar_events_linked_lead";
--> statement-breakpoint
ALTER TABLE "calendar_events" DROP CONSTRAINT IF EXISTS "fk_calendar_events_linked_lead_id_org";
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "fk_calendar_events_linked_lead_id_org"
  FOREIGN KEY ("org_id", "linked_lead_id") REFERENCES "public"."lead_party_map"("organization_id", "lead_id") ON DELETE SET NULL ("linked_lead_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "calendar_events" VALIDATE CONSTRAINT "fk_calendar_events_linked_lead_id_org";
--> statement-breakpoint

ALTER TABLE "survey_participants" DROP CONSTRAINT IF EXISTS "survey_participants_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "survey_participants" DROP CONSTRAINT IF EXISTS "fk_survey_participants_lead_id_org";
--> statement-breakpoint
ALTER TABLE "survey_participants" ADD CONSTRAINT "fk_survey_participants_lead_id_org"
  FOREIGN KEY ("org_id", "lead_id") REFERENCES "public"."lead_party_map"("organization_id", "lead_id") ON DELETE SET NULL ("lead_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "survey_participants" VALIDATE CONSTRAINT "fk_survey_participants_lead_id_org";
