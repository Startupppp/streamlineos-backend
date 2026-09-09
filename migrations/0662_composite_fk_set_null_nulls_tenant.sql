-- 0662 — a composite FK cannot SET NULL, because Postgres nulls the tenant too.
--
-- 43 composite foreign keys were declared `ON DELETE SET NULL` while including a
-- NOT NULL column. Postgres's bare SET NULL nulls EVERY column of the key, so on
-- (org_id, <x>_party_id) it emits
--
--   UPDATE ONLY <child> SET "org_id" = NULL, "<x>_party_id" = NULL ...
--
-- and org_id is NOT NULL on all of them. The parent DELETE therefore aborts with
-- a not-null violation on the CHILD table — a constraint that can never fire the
-- action it declares. Measured, not inferred:
--
--   ERROR: null value in column "org_id" of relation "crm_contact_channel_consent"
--          violates not-null constraint
--
-- It has gone unnoticed because parties are normally SOFT-deleted
-- (business_parties.deleted_at). It bites only on the hard-delete path — DPDP
-- erasure — which is the one place a hard delete is legally required. The
-- existing spec `crm-optout-survives-erasure.seeded-e2e-spec.ts` already works
-- around it and names it as a defect to be reported separately. This is that
-- report, fixed.
--
-- ORIGIN. The bulk comes from 0272/0275 (Phase 2 ticket 08), which ported the
-- legacy single-column `client_id`/`lead_id` keys to the composite tenant form.
-- Their stated purpose was cross-tenant safety — "a bare REFERENCES ... would
-- permit exactly the cross-tenant reference the whole identity model exists to
-- prevent" — and the ON DELETE clause was carried across unchanged. Nothing in
-- either migration intended to change delete semantics, and nobody can have
-- intended to null org_id: that orphans the row from its tenant even if org_id
-- were nullable. This is a syntax defect, not a design decision. 0619 then
-- transcribed the broken shape back out of pg_catalog (63 bare SET NULLs, zero
-- column-list forms), which is why it reads as deliberate.
--
-- THE TWO REPAIRS. The house already knows both, and applies each where it fits.
--
--   NO ACTION (28) — everything keyed to business_parties, plus deals→subjects
--   and crm_nurture_enrollments→deals. These are the erasure path, and
--   `subject-request-plan.ts` is explicit that a disposition is declared per
--   table and executed explicitly: a table with no declared disposition "is
--   neither erased ... nor skipped in silence". A database-level SET NULL would
--   silently perform an undeclared disposition on 26 tables the compliance
--   design deliberately refuses to decide about, and leave rows that still hold
--   personal data (an orphaned consent row keeps contact_id; an orphaned invoice
--   keeps a client that no longer resolves). NO ACTION preserves the behaviour
--   these already have — the delete is refused — and replaces an incoherent
--   not-null error with an honest one that names the blocking table. The
--   erasure flow clears children first, which is what 0607 established and what
--   the opt-out spec describes: "an erasure must clear consent before the party,
--   which is what an erasure does anyway".
--
--   SET NULL (<column>) (9) — the kb_* structural set. 0635 authored SET NULL
--   deliberately here and it is right: an article whose category is deleted
--   becomes uncategorised, a page whose space or parent is deleted becomes
--   unfiled or top-level. No parent in this group is personal data and no
--   erasure path runs through it. Postgres 15's column-list form nulls the
--   pointer and leaves org_id alone, which is what "SET NULL" meant all along.
--   Precedent: 0607 (`fk_vault_access_logs_vault_document_id_org`) and 0634
--   (`fk_role_assignments_assigner_membership`,
--   `fk_user_permission_grants_granter_membership`) already use it — those three
--   are the only composite SET NULLs in the database that are correct today.
--
-- NOT REPAIRED HERE. Six constraints on build.tickets, build.feedback_posts and
-- build.feedbucket_submissions carry the same defect. They belong to the build
-- module and are reported to its owner rather than changed here.
--
-- LOCKING. Each rebuild takes ACCESS EXCLUSIVE, so it is split: DROP + ADD
-- ... NOT VALID is a catalog-only change that does not scan the table, and
-- VALIDATE CONSTRAINT then takes only SHARE UPDATE EXCLUSIVE. The rows already
-- satisfy every key — only the ON DELETE action changes — so validation cannot
-- fail on existing data.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "public"."calendar_events" DROP CONSTRAINT "fk_calendar_events_linked_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."calendar_events"
  ADD CONSTRAINT "fk_calendar_events_linked_lead_party_id"
  FOREIGN KEY ("org_id", "linked_lead_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."calendar_events" VALIDATE CONSTRAINT "fk_calendar_events_linked_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."client_accounts" DROP CONSTRAINT "fk_client_accounts_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."client_accounts"
  ADD CONSTRAINT "fk_client_accounts_lead_party_id"
  FOREIGN KEY ("org_id", "lead_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."client_accounts" VALIDATE CONSTRAINT "fk_client_accounts_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."client_onboarding_items" DROP CONSTRAINT "fk_client_onboarding_items_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."client_onboarding_items"
  ADD CONSTRAINT "fk_client_onboarding_items_client_party_id"
  FOREIGN KEY ("org_id", "client_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."client_onboarding_items" VALIDATE CONSTRAINT "fk_client_onboarding_items_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."client_opportunities" DROP CONSTRAINT "fk_client_opportunities_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."client_opportunities"
  ADD CONSTRAINT "fk_client_opportunities_client_party_id"
  FOREIGN KEY ("org_id", "client_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."client_opportunities" VALIDATE CONSTRAINT "fk_client_opportunities_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."crm_contact_channel_consent" DROP CONSTRAINT "fk_crm_contact_channel_consent_contact_party_id";
--> statement-breakpoint
ALTER TABLE "public"."crm_contact_channel_consent"
  ADD CONSTRAINT "fk_crm_contact_channel_consent_contact_party_id"
  FOREIGN KEY ("org_id", "contact_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."crm_contact_channel_consent" VALIDATE CONSTRAINT "fk_crm_contact_channel_consent_contact_party_id";
--> statement-breakpoint
ALTER TABLE "public"."crm_contact_consent_events" DROP CONSTRAINT "fk_crm_contact_consent_events_contact_party_id";
--> statement-breakpoint
ALTER TABLE "public"."crm_contact_consent_events"
  ADD CONSTRAINT "fk_crm_contact_consent_events_contact_party_id"
  FOREIGN KEY ("org_id", "contact_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."crm_contact_consent_events" VALIDATE CONSTRAINT "fk_crm_contact_consent_events_contact_party_id";
--> statement-breakpoint
ALTER TABLE "public"."crm_contact_roles" DROP CONSTRAINT "fk_crm_contact_roles_contact_party_id";
--> statement-breakpoint
ALTER TABLE "public"."crm_contact_roles"
  ADD CONSTRAINT "fk_crm_contact_roles_contact_party_id"
  FOREIGN KEY ("org_id", "contact_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."crm_contact_roles" VALIDATE CONSTRAINT "fk_crm_contact_roles_contact_party_id";
--> statement-breakpoint
ALTER TABLE "public"."crm_deal_stakeholders" DROP CONSTRAINT "fk_crm_deal_stakeholders_contact_party_id";
--> statement-breakpoint
ALTER TABLE "public"."crm_deal_stakeholders"
  ADD CONSTRAINT "fk_crm_deal_stakeholders_contact_party_id"
  FOREIGN KEY ("org_id", "contact_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."crm_deal_stakeholders" VALIDATE CONSTRAINT "fk_crm_deal_stakeholders_contact_party_id";
--> statement-breakpoint
ALTER TABLE "public"."crm_lead_touchpoints" DROP CONSTRAINT "fk_crm_lead_touchpoints_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."crm_lead_touchpoints"
  ADD CONSTRAINT "fk_crm_lead_touchpoints_lead_party_id"
  FOREIGN KEY ("org_id", "lead_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."crm_lead_touchpoints" VALIDATE CONSTRAINT "fk_crm_lead_touchpoints_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."crm_nurture_enrollments" DROP CONSTRAINT "fk_crm_nurture_enrollments_deal";
--> statement-breakpoint
ALTER TABLE "public"."crm_nurture_enrollments"
  ADD CONSTRAINT "fk_crm_nurture_enrollments_deal"
  FOREIGN KEY ("organization_id", "deal_id")
  REFERENCES "public"."deals" ("org_id", "id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."crm_nurture_enrollments" VALIDATE CONSTRAINT "fk_crm_nurture_enrollments_deal";
--> statement-breakpoint
ALTER TABLE "public"."csat_surveys" DROP CONSTRAINT "fk_csat_surveys_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."csat_surveys"
  ADD CONSTRAINT "fk_csat_surveys_client_party_id"
  FOREIGN KEY ("org_id", "client_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."csat_surveys" VALIDATE CONSTRAINT "fk_csat_surveys_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."deals" DROP CONSTRAINT "fk_deals_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."deals"
  ADD CONSTRAINT "fk_deals_lead_party_id"
  FOREIGN KEY ("org_id", "lead_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."deals" VALIDATE CONSTRAINT "fk_deals_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."deals" DROP CONSTRAINT "fk_deals_party";
--> statement-breakpoint
ALTER TABLE "public"."deals"
  ADD CONSTRAINT "fk_deals_party"
  FOREIGN KEY ("org_id", "party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."deals" VALIDATE CONSTRAINT "fk_deals_party";
--> statement-breakpoint
ALTER TABLE "public"."deals" DROP CONSTRAINT "fk_deals_subject";
--> statement-breakpoint
ALTER TABLE "public"."deals"
  ADD CONSTRAINT "fk_deals_subject"
  FOREIGN KEY ("org_id", "subject_id")
  REFERENCES "public"."subjects" ("organization_id", "subject_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."deals" VALIDATE CONSTRAINT "fk_deals_subject";
--> statement-breakpoint
ALTER TABLE "public"."inv_customer_returns" DROP CONSTRAINT "fk_inv_customer_returns_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."inv_customer_returns"
  ADD CONSTRAINT "fk_inv_customer_returns_client_party_id"
  FOREIGN KEY ("org_id", "client_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."inv_customer_returns" VALIDATE CONSTRAINT "fk_inv_customer_returns_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."inv_sales_orders" DROP CONSTRAINT "fk_inv_sales_orders_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."inv_sales_orders"
  ADD CONSTRAINT "fk_inv_sales_orders_client_party_id"
  FOREIGN KEY ("org_id", "client_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."inv_sales_orders" VALIDATE CONSTRAINT "fk_inv_sales_orders_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."inv_vendors" DROP CONSTRAINT "fk_inv_vendors_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."inv_vendors"
  ADD CONSTRAINT "fk_inv_vendors_client_party_id"
  FOREIGN KEY ("org_id", "client_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."inv_vendors" VALIDATE CONSTRAINT "fk_inv_vendors_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."invoices" DROP CONSTRAINT "fk_invoices_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."invoices"
  ADD CONSTRAINT "fk_invoices_client_party_id"
  FOREIGN KEY ("org_id", "client_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."invoices" VALIDATE CONSTRAINT "fk_invoices_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."kb_articles" DROP CONSTRAINT "fk_kb_articles_org_category";
--> statement-breakpoint
ALTER TABLE "public"."kb_articles"
  ADD CONSTRAINT "fk_kb_articles_org_category"
  FOREIGN KEY ("org_id", "category_id")
  REFERENCES "public"."kb_categories" ("org_id", "id")
  ON DELETE SET NULL ("category_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_articles" VALIDATE CONSTRAINT "fk_kb_articles_org_category";
--> statement-breakpoint
ALTER TABLE "public"."kb_categories" DROP CONSTRAINT "fk_kb_categories_org_parent";
--> statement-breakpoint
ALTER TABLE "public"."kb_categories"
  ADD CONSTRAINT "fk_kb_categories_org_parent"
  FOREIGN KEY ("org_id", "parent_id")
  REFERENCES "public"."kb_categories" ("org_id", "id")
  ON DELETE SET NULL ("parent_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_categories" VALIDATE CONSTRAINT "fk_kb_categories_org_parent";
--> statement-breakpoint
ALTER TABLE "public"."kb_events" DROP CONSTRAINT "fk_kb_events_org_article";
--> statement-breakpoint
ALTER TABLE "public"."kb_events"
  ADD CONSTRAINT "fk_kb_events_org_article"
  FOREIGN KEY ("org_id", "article_id")
  REFERENCES "public"."kb_articles" ("org_id", "id")
  ON DELETE SET NULL ("article_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_events" VALIDATE CONSTRAINT "fk_kb_events_org_article";
--> statement-breakpoint
ALTER TABLE "public"."kb_pages" DROP CONSTRAINT "fk_kb_pages_org_parent";
--> statement-breakpoint
ALTER TABLE "public"."kb_pages"
  ADD CONSTRAINT "fk_kb_pages_org_parent"
  FOREIGN KEY ("org_id", "parent_page_id")
  REFERENCES "public"."kb_pages" ("org_id", "id")
  ON DELETE SET NULL ("parent_page_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_org_parent";
--> statement-breakpoint
ALTER TABLE "public"."kb_pages" DROP CONSTRAINT "fk_kb_pages_org_project";
--> statement-breakpoint
ALTER TABLE "public"."kb_pages"
  ADD CONSTRAINT "fk_kb_pages_org_project"
  FOREIGN KEY ("org_id", "project_id")
  REFERENCES "build"."projects" ("org_id", "id")
  ON DELETE SET NULL ("project_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_org_project";
--> statement-breakpoint
ALTER TABLE "public"."kb_pages" DROP CONSTRAINT "fk_kb_pages_org_source_article";
--> statement-breakpoint
ALTER TABLE "public"."kb_pages"
  ADD CONSTRAINT "fk_kb_pages_org_source_article"
  FOREIGN KEY ("org_id", "source_article_id")
  REFERENCES "public"."kb_articles" ("org_id", "id")
  ON DELETE SET NULL ("source_article_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_org_source_article";
--> statement-breakpoint
ALTER TABLE "public"."kb_pages" DROP CONSTRAINT "fk_kb_pages_org_space";
--> statement-breakpoint
ALTER TABLE "public"."kb_pages"
  ADD CONSTRAINT "fk_kb_pages_org_space"
  FOREIGN KEY ("org_id", "space_id")
  REFERENCES "public"."kb_spaces" ("org_id", "id")
  ON DELETE SET NULL ("space_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_org_space";
--> statement-breakpoint
ALTER TABLE "public"."kb_research_briefs" DROP CONSTRAINT "fk_kb_research_briefs_org_space";
--> statement-breakpoint
ALTER TABLE "public"."kb_research_briefs"
  ADD CONSTRAINT "fk_kb_research_briefs_org_space"
  FOREIGN KEY ("org_id", "space_id")
  REFERENCES "public"."kb_spaces" ("org_id", "id")
  ON DELETE SET NULL ("space_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_research_briefs" VALIDATE CONSTRAINT "fk_kb_research_briefs_org_space";
--> statement-breakpoint
ALTER TABLE "public"."kb_sources" DROP CONSTRAINT "fk_kb_sources_org_space";
--> statement-breakpoint
ALTER TABLE "public"."kb_sources"
  ADD CONSTRAINT "fk_kb_sources_org_space"
  FOREIGN KEY ("org_id", "space_id")
  REFERENCES "public"."kb_spaces" ("org_id", "id")
  ON DELETE SET NULL ("space_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_sources" VALIDATE CONSTRAINT "fk_kb_sources_org_space";
--> statement-breakpoint
ALTER TABLE "public"."lead_activities" DROP CONSTRAINT "fk_lead_activities_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."lead_activities"
  ADD CONSTRAINT "fk_lead_activities_lead_party_id"
  FOREIGN KEY ("org_id", "lead_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."lead_activities" VALIDATE CONSTRAINT "fk_lead_activities_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."lead_emails" DROP CONSTRAINT "fk_lead_emails_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."lead_emails"
  ADD CONSTRAINT "fk_lead_emails_lead_party_id"
  FOREIGN KEY ("org_id", "lead_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."lead_emails" VALIDATE CONSTRAINT "fk_lead_emails_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."lead_notes" DROP CONSTRAINT "fk_lead_notes_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."lead_notes"
  ADD CONSTRAINT "fk_lead_notes_lead_party_id"
  FOREIGN KEY ("org_id", "lead_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."lead_notes" VALIDATE CONSTRAINT "fk_lead_notes_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."lead_tasks" DROP CONSTRAINT "fk_lead_tasks_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."lead_tasks"
  ADD CONSTRAINT "fk_lead_tasks_lead_party_id"
  FOREIGN KEY ("org_id", "lead_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."lead_tasks" VALIDATE CONSTRAINT "fk_lead_tasks_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."purchase_bills" DROP CONSTRAINT "fk_purchase_bills_vendor_party_id";
--> statement-breakpoint
ALTER TABLE "public"."purchase_bills"
  ADD CONSTRAINT "fk_purchase_bills_vendor_party_id"
  FOREIGN KEY ("org_id", "vendor_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."purchase_bills" VALIDATE CONSTRAINT "fk_purchase_bills_vendor_party_id";
--> statement-breakpoint
ALTER TABLE "public"."support_tickets" DROP CONSTRAINT "fk_support_tickets_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."support_tickets"
  ADD CONSTRAINT "fk_support_tickets_client_party_id"
  FOREIGN KEY ("org_id", "client_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."support_tickets" VALIDATE CONSTRAINT "fk_support_tickets_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."support_vip_clients" DROP CONSTRAINT "fk_support_vip_clients_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."support_vip_clients"
  ADD CONSTRAINT "fk_support_vip_clients_client_party_id"
  FOREIGN KEY ("org_id", "client_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."support_vip_clients" VALIDATE CONSTRAINT "fk_support_vip_clients_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."survey_participants" DROP CONSTRAINT "fk_survey_participants_contact_party_id";
--> statement-breakpoint
ALTER TABLE "public"."survey_participants"
  ADD CONSTRAINT "fk_survey_participants_contact_party_id"
  FOREIGN KEY ("org_id", "contact_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."survey_participants" VALIDATE CONSTRAINT "fk_survey_participants_contact_party_id";
--> statement-breakpoint
ALTER TABLE "public"."survey_participants" DROP CONSTRAINT "fk_survey_participants_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."survey_participants"
  ADD CONSTRAINT "fk_survey_participants_lead_party_id"
  FOREIGN KEY ("org_id", "lead_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."survey_participants" VALIDATE CONSTRAINT "fk_survey_participants_lead_party_id";
--> statement-breakpoint
ALTER TABLE "public"."timesheet_rates" DROP CONSTRAINT "fk_timesheet_rates_client_party_id";
--> statement-breakpoint
ALTER TABLE "public"."timesheet_rates"
  ADD CONSTRAINT "fk_timesheet_rates_client_party_id"
  FOREIGN KEY ("org_id", "client_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."timesheet_rates" VALIDATE CONSTRAINT "fk_timesheet_rates_client_party_id";
