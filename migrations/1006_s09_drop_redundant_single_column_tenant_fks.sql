-- Sixteen foreign keys are declared twice between the same child column and the
-- same parent: once as a single-column constraint and once as the canonical
-- organisation-scoped composite (org_id, child_id) -> parent (org_id, id).
-- The single-column half is redundant for referential integrity and actively
-- wrong for tenancy: it lets a row in one organisation reference a parent in
-- another, which is exactly what the composite exists to forbid. Verified pair
-- by pair against pg_constraint on a bootstrapped database before removal --
-- every child column below has a live composite twin naming the same parent.
--
-- Two shapes, and the difference matters. Where both constraints already carry
-- the same referential action the single-column half is dropped outright and
-- parent-delete behaviour is bit-identical afterwards. Where the actions differ
-- the action is MOVED onto the composite first: dropping a SET NULL twin while
-- the composite says NO ACTION silently converts "clear the pointer" into
-- 23503 on every parent delete, and dropping a CASCADE twin the same way turns
-- a cascading delete into a refusal. The composite is where the tenant conjunct
-- lives, so it is where the action belongs.
--
--   IDENTICAL ACTION (NO ACTION on both) -- drop only:
--     credit_notes.client_id                     -> clients
--     fin_collection_activities.client_id        -> clients
--     fin_payment_run_items.vendor_id            -> clients
--     fin_recurring_bill_templates.vendor_id     -> clients
--     fin_recurring_invoice_templates.client_id  -> clients
--     vendor_credits.vendor_id                   -> clients
--     acc_fixed_assets.vendor_id                 -> clients
--     support_tickets.client_id                  -> clients
--
--   ACTION MOVED ONTO THE COMPOSITE:
--     support_vip_clients.client_id     -> clients          CASCADE
--     chat_channels.linked_deal_id      -> deals            SET NULL (linked_deal_id)
--     enterprise_quotes.deal_id         -> deals            SET NULL (deal_id)
--     enterprise_quotes.client_id       -> client_accounts  SET NULL (client_id)
--     build.projects.deal_id            -> deals            SET NULL (deal_id)
--     survey_participants.contact_id    -> contacts         SET NULL (contact_id)
--     survey_participants.lead_id       -> leads            SET NULL (lead_id)
--     survey_participants.client_id     -> client_accounts  SET NULL (client_id)
--
-- Every SET NULL composite carries an explicit column list. org_id is NOT NULL
-- on all six tables, so a bare composite SET NULL would try to null the tenant
-- column and raise 23502 on every parent delete instead of clearing the pointer
-- -- the defect 0770 swept and 0992 repaired. The column lists here name only
-- the nullable pointer column.
--
-- No trigger is added or altered by this file, and no referential action is
-- weakened, so the organisation purge path (cron-org-purge-worker deletes the
-- organizations row and relies on cascade) behaves exactly as it did before:
-- each of these children is still reached through its own org_id cascade.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE credit_notes DROP CONSTRAINT IF EXISTS credit_notes_client_id_clients_id_fk;
--> statement-breakpoint

ALTER TABLE fin_collection_activities DROP CONSTRAINT IF EXISTS fin_collection_activities_client_id_clients_id_fk;
--> statement-breakpoint

ALTER TABLE fin_payment_run_items DROP CONSTRAINT IF EXISTS fin_payment_run_items_vendor_id_clients_id_fk;
--> statement-breakpoint

ALTER TABLE fin_recurring_bill_templates DROP CONSTRAINT IF EXISTS fin_recurring_bill_templates_vendor_id_clients_id_fk;
--> statement-breakpoint

ALTER TABLE fin_recurring_invoice_templates DROP CONSTRAINT IF EXISTS fin_recurring_invoice_templates_client_id_clients_id_fk;
--> statement-breakpoint

ALTER TABLE vendor_credits DROP CONSTRAINT IF EXISTS vendor_credits_vendor_id_clients_id_fk;
--> statement-breakpoint

ALTER TABLE acc_fixed_assets DROP CONSTRAINT IF EXISTS acc_fixed_assets_vendor_id_clients_id_fk;
--> statement-breakpoint

ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_client_id_clients_id_fk;
--> statement-breakpoint

ALTER TABLE support_vip_clients DROP CONSTRAINT IF EXISTS support_vip_clients_client_id_clients_id_fk;
--> statement-breakpoint

ALTER TABLE support_vip_clients DROP CONSTRAINT IF EXISTS fk_support_vip_clients_client_id_org;
--> statement-breakpoint

ALTER TABLE support_vip_clients
  ADD CONSTRAINT fk_support_vip_clients_client_id_org
  FOREIGN KEY (org_id, client_id)
  REFERENCES clients (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint

ALTER TABLE support_vip_clients VALIDATE CONSTRAINT fk_support_vip_clients_client_id_org;
--> statement-breakpoint

ALTER TABLE chat_channels DROP CONSTRAINT IF EXISTS chat_channels_linked_deal_id_deals_id_fk;
--> statement-breakpoint

ALTER TABLE chat_channels DROP CONSTRAINT IF EXISTS fk_chat_channels_linked_deal_id_org;
--> statement-breakpoint

ALTER TABLE chat_channels
  ADD CONSTRAINT fk_chat_channels_linked_deal_id_org
  FOREIGN KEY (org_id, linked_deal_id)
  REFERENCES deals (org_id, id)
  ON DELETE SET NULL (linked_deal_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE chat_channels VALIDATE CONSTRAINT fk_chat_channels_linked_deal_id_org;
--> statement-breakpoint

ALTER TABLE enterprise_quotes DROP CONSTRAINT IF EXISTS enterprise_quotes_deal_id_deals_id_fk;
--> statement-breakpoint

ALTER TABLE enterprise_quotes DROP CONSTRAINT IF EXISTS fk_enterprise_quotes_deal_id_org;
--> statement-breakpoint

ALTER TABLE enterprise_quotes
  ADD CONSTRAINT fk_enterprise_quotes_deal_id_org
  FOREIGN KEY (org_id, deal_id)
  REFERENCES deals (org_id, id)
  ON DELETE SET NULL (deal_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE enterprise_quotes VALIDATE CONSTRAINT fk_enterprise_quotes_deal_id_org;
--> statement-breakpoint

ALTER TABLE enterprise_quotes DROP CONSTRAINT IF EXISTS enterprise_quotes_client_id_client_accounts_id_fk;
--> statement-breakpoint

ALTER TABLE enterprise_quotes DROP CONSTRAINT IF EXISTS fk_enterprise_quotes_client_id_org;
--> statement-breakpoint

ALTER TABLE enterprise_quotes
  ADD CONSTRAINT fk_enterprise_quotes_client_id_org
  FOREIGN KEY (org_id, client_id)
  REFERENCES client_accounts (org_id, id)
  ON DELETE SET NULL (client_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE enterprise_quotes VALIDATE CONSTRAINT fk_enterprise_quotes_client_id_org;
--> statement-breakpoint

ALTER TABLE build.projects DROP CONSTRAINT IF EXISTS projects_deal_id_deals_id_fk;
--> statement-breakpoint

ALTER TABLE build.projects DROP CONSTRAINT IF EXISTS fk_projects_deal_id_org;
--> statement-breakpoint

ALTER TABLE build.projects
  ADD CONSTRAINT fk_projects_deal_id_org
  FOREIGN KEY (org_id, deal_id)
  REFERENCES deals (org_id, id)
  ON DELETE SET NULL (deal_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE build.projects VALIDATE CONSTRAINT fk_projects_deal_id_org;
--> statement-breakpoint

ALTER TABLE survey_participants DROP CONSTRAINT IF EXISTS survey_participants_contact_id_contacts_id_fk;
--> statement-breakpoint

ALTER TABLE survey_participants DROP CONSTRAINT IF EXISTS fk_survey_participants_contact_id_org;
--> statement-breakpoint

ALTER TABLE survey_participants
  ADD CONSTRAINT fk_survey_participants_contact_id_org
  FOREIGN KEY (org_id, contact_id)
  REFERENCES contacts (org_id, id)
  ON DELETE SET NULL (contact_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE survey_participants VALIDATE CONSTRAINT fk_survey_participants_contact_id_org;
--> statement-breakpoint

ALTER TABLE survey_participants DROP CONSTRAINT IF EXISTS survey_participants_lead_id_leads_id_fk;
--> statement-breakpoint

ALTER TABLE survey_participants DROP CONSTRAINT IF EXISTS fk_survey_participants_lead_id_org;
--> statement-breakpoint

ALTER TABLE survey_participants
  ADD CONSTRAINT fk_survey_participants_lead_id_org
  FOREIGN KEY (org_id, lead_id)
  REFERENCES leads (org_id, id)
  ON DELETE SET NULL (lead_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE survey_participants VALIDATE CONSTRAINT fk_survey_participants_lead_id_org;
--> statement-breakpoint

ALTER TABLE survey_participants DROP CONSTRAINT IF EXISTS survey_participants_client_id_client_accounts_id_fk;
--> statement-breakpoint

ALTER TABLE survey_participants DROP CONSTRAINT IF EXISTS fk_survey_participants_client_id_org;
--> statement-breakpoint

ALTER TABLE survey_participants
  ADD CONSTRAINT fk_survey_participants_client_id_org
  FOREIGN KEY (org_id, client_id)
  REFERENCES client_accounts (org_id, id)
  ON DELETE SET NULL (client_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE survey_participants VALIDATE CONSTRAINT fk_survey_participants_client_id_org;
--> statement-breakpoint

DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(rel.relname || '.' || con.conname, ', ' ORDER BY con.conname)
    INTO offenders
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE con.conname IN (
           'credit_notes_client_id_clients_id_fk',
           'fin_collection_activities_client_id_clients_id_fk',
           'fin_payment_run_items_vendor_id_clients_id_fk',
           'fin_recurring_bill_templates_vendor_id_clients_id_fk',
           'fin_recurring_invoice_templates_client_id_clients_id_fk',
           'vendor_credits_vendor_id_clients_id_fk',
           'acc_fixed_assets_vendor_id_clients_id_fk',
           'support_tickets_client_id_clients_id_fk',
           'support_vip_clients_client_id_clients_id_fk',
           'chat_channels_linked_deal_id_deals_id_fk',
           'enterprise_quotes_deal_id_deals_id_fk',
           'enterprise_quotes_client_id_client_accounts_id_fk',
           'projects_deal_id_deals_id_fk',
           'survey_participants_contact_id_contacts_id_fk',
           'survey_participants_lead_id_leads_id_fk',
           'survey_participants_client_id_client_accounts_id_fk');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'redundant single-column tenant foreign keys survived the drop: %', offenders;
  END IF;

  SELECT string_agg(rel.relname || '.' || con.conname, ', ' ORDER BY con.conname)
    INTO offenders
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE con.conname IN (
           'fk_support_vip_clients_client_id_org',
           'fk_chat_channels_linked_deal_id_org',
           'fk_enterprise_quotes_deal_id_org',
           'fk_enterprise_quotes_client_id_org',
           'fk_projects_deal_id_org',
           'fk_survey_participants_contact_id_org',
           'fk_survey_participants_lead_id_org',
           'fk_survey_participants_client_id_org',
           'fk_credit_notes_client_id_org',
           'fk_fin_collection_activities_client_id_org',
           'fk_fin_payment_run_items_vendor_id_org',
           'fk_fin_recurring_bill_templates_vendor_id_org',
           'fk_fin_recurring_invoice_templates_client_id_org',
           'fk_vendor_credits_vendor_id_org',
           'fk_acc_fixed_assets_vendor_id_org',
           'fk_support_tickets_client_id_org')
     AND (
       con.convalidated IS NOT TRUE
       OR EXISTS (
         SELECT 1
           FROM unnest(COALESCE(con.confdelsetcols, ARRAY[]::smallint[])) z(attnum)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = z.attnum
          WHERE a.attnotnull)
       OR (con.confdeltype = 'n' AND con.confdelsetcols IS NULL));

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'composite tenant foreign keys left in an unusable shape: %', offenders;
  END IF;

  IF (SELECT count(*) FROM pg_constraint WHERE conname IN (
        'fk_support_vip_clients_client_id_org',
        'fk_chat_channels_linked_deal_id_org',
        'fk_enterprise_quotes_deal_id_org',
        'fk_enterprise_quotes_client_id_org',
        'fk_projects_deal_id_org',
        'fk_survey_participants_contact_id_org',
        'fk_survey_participants_lead_id_org',
        'fk_survey_participants_client_id_org',
        'fk_credit_notes_client_id_org',
        'fk_fin_collection_activities_client_id_org',
        'fk_fin_payment_run_items_vendor_id_org',
        'fk_fin_recurring_bill_templates_vendor_id_org',
        'fk_fin_recurring_invoice_templates_client_id_org',
        'fk_vendor_credits_vendor_id_org',
        'fk_acc_fixed_assets_vendor_id_org',
        'fk_support_tickets_client_id_org')) <> 16 THEN
    RAISE EXCEPTION 'a composite tenant foreign key this migration relies on is missing';
  END IF;
END $$;
