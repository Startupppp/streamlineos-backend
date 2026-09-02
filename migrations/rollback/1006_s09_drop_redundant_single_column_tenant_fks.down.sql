-- 1006 DOWN -- restores the sixteen single-column constraints and returns the eight
-- composite twins whose referential action this migration moved to the NO ACTION
-- shape they carried before it.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE credit_notes
  ADD CONSTRAINT credit_notes_client_id_clients_id_fk
  FOREIGN KEY (client_id) REFERENCES clients (id) NOT VALID;
--> statement-breakpoint

ALTER TABLE fin_collection_activities
  ADD CONSTRAINT fin_collection_activities_client_id_clients_id_fk
  FOREIGN KEY (client_id) REFERENCES clients (id) NOT VALID;
--> statement-breakpoint

ALTER TABLE fin_payment_run_items
  ADD CONSTRAINT fin_payment_run_items_vendor_id_clients_id_fk
  FOREIGN KEY (vendor_id) REFERENCES clients (id) NOT VALID;
--> statement-breakpoint

ALTER TABLE fin_recurring_bill_templates
  ADD CONSTRAINT fin_recurring_bill_templates_vendor_id_clients_id_fk
  FOREIGN KEY (vendor_id) REFERENCES clients (id) NOT VALID;
--> statement-breakpoint

ALTER TABLE fin_recurring_invoice_templates
  ADD CONSTRAINT fin_recurring_invoice_templates_client_id_clients_id_fk
  FOREIGN KEY (client_id) REFERENCES clients (id) NOT VALID;
--> statement-breakpoint

ALTER TABLE vendor_credits
  ADD CONSTRAINT vendor_credits_vendor_id_clients_id_fk
  FOREIGN KEY (vendor_id) REFERENCES clients (id) NOT VALID;
--> statement-breakpoint

ALTER TABLE acc_fixed_assets
  ADD CONSTRAINT acc_fixed_assets_vendor_id_clients_id_fk
  FOREIGN KEY (vendor_id) REFERENCES clients (id) NOT VALID;
--> statement-breakpoint

ALTER TABLE support_tickets
  ADD CONSTRAINT support_tickets_client_id_clients_id_fk
  FOREIGN KEY (client_id) REFERENCES clients (id) NOT VALID;
--> statement-breakpoint

ALTER TABLE support_vip_clients DROP CONSTRAINT IF EXISTS fk_support_vip_clients_client_id_org;
--> statement-breakpoint

ALTER TABLE support_vip_clients
  ADD CONSTRAINT fk_support_vip_clients_client_id_org
  FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE support_vip_clients
  ADD CONSTRAINT support_vip_clients_client_id_clients_id_fk
  FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE chat_channels DROP CONSTRAINT IF EXISTS fk_chat_channels_linked_deal_id_org;
--> statement-breakpoint

ALTER TABLE chat_channels
  ADD CONSTRAINT fk_chat_channels_linked_deal_id_org
  FOREIGN KEY (org_id, linked_deal_id) REFERENCES deals (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE chat_channels
  ADD CONSTRAINT chat_channels_linked_deal_id_deals_id_fk
  FOREIGN KEY (linked_deal_id) REFERENCES deals (id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE enterprise_quotes DROP CONSTRAINT IF EXISTS fk_enterprise_quotes_deal_id_org;
--> statement-breakpoint

ALTER TABLE enterprise_quotes
  ADD CONSTRAINT fk_enterprise_quotes_deal_id_org
  FOREIGN KEY (org_id, deal_id) REFERENCES deals (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE enterprise_quotes
  ADD CONSTRAINT enterprise_quotes_deal_id_deals_id_fk
  FOREIGN KEY (deal_id) REFERENCES deals (id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE enterprise_quotes DROP CONSTRAINT IF EXISTS fk_enterprise_quotes_client_id_org;
--> statement-breakpoint

ALTER TABLE enterprise_quotes
  ADD CONSTRAINT fk_enterprise_quotes_client_id_org
  FOREIGN KEY (org_id, client_id) REFERENCES client_accounts (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE enterprise_quotes
  ADD CONSTRAINT enterprise_quotes_client_id_client_accounts_id_fk
  FOREIGN KEY (client_id) REFERENCES client_accounts (id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE build.projects DROP CONSTRAINT IF EXISTS fk_projects_deal_id_org;
--> statement-breakpoint

ALTER TABLE build.projects
  ADD CONSTRAINT fk_projects_deal_id_org
  FOREIGN KEY (org_id, deal_id) REFERENCES deals (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE build.projects
  ADD CONSTRAINT projects_deal_id_deals_id_fk
  FOREIGN KEY (deal_id) REFERENCES deals (id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE survey_participants DROP CONSTRAINT IF EXISTS fk_survey_participants_contact_id_org;
--> statement-breakpoint

ALTER TABLE survey_participants
  ADD CONSTRAINT fk_survey_participants_contact_id_org
  FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE survey_participants
  ADD CONSTRAINT survey_participants_contact_id_contacts_id_fk
  FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE survey_participants DROP CONSTRAINT IF EXISTS fk_survey_participants_lead_id_org;
--> statement-breakpoint

ALTER TABLE survey_participants
  ADD CONSTRAINT fk_survey_participants_lead_id_org
  FOREIGN KEY (org_id, lead_id) REFERENCES leads (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE survey_participants
  ADD CONSTRAINT survey_participants_lead_id_leads_id_fk
  FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE survey_participants DROP CONSTRAINT IF EXISTS fk_survey_participants_client_id_org;
--> statement-breakpoint

ALTER TABLE survey_participants
  ADD CONSTRAINT fk_survey_participants_client_id_org
  FOREIGN KEY (org_id, client_id) REFERENCES client_accounts (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE survey_participants
  ADD CONSTRAINT survey_participants_client_id_client_accounts_id_fk
  FOREIGN KEY (client_id) REFERENCES client_accounts (id) ON DELETE SET NULL NOT VALID;
