-- Reverses 1003. The nine duplicate anchors come back as UNIQUE constraints under
-- their original names and the six narrower indexes are recreated, so the catalog
-- returns to its pre-1003 shape. No foreign key referenced any dropped object, so
-- nothing has to be revalidated.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE user_delegations ADD CONSTRAINT uniq_user_delegations_org_delegation UNIQUE (org_id, id);
--> statement-breakpoint

ALTER TABLE organization_people ADD CONSTRAINT uniq_organization_people_org_id UNIQUE (organization_id, organization_person_id);
--> statement-breakpoint

ALTER TABLE workers ADD CONSTRAINT uniq_workers_org_id UNIQUE (organization_id, worker_id);
--> statement-breakpoint

ALTER TABLE business_parties ADD CONSTRAINT uniq_business_parties_org_id UNIQUE (organization_id, party_id);
--> statement-breakpoint

ALTER TABLE party_contacts ADD CONSTRAINT uniq_party_contacts_org_id UNIQUE (organization_id, party_contact_id);
--> statement-breakpoint

ALTER TABLE portal_memberships ADD CONSTRAINT uniq_portal_memberships_org_id UNIQUE (organization_id, portal_membership_id);
--> statement-breakpoint

ALTER TABLE principal_groups ADD CONSTRAINT principal_groups_org_id_id_uniq UNIQUE (org_id, id);
--> statement-breakpoint

ALTER TABLE custom_field_definitions ADD CONSTRAINT uniq_custom_field_definitions_org_id UNIQUE (org_id, id);
--> statement-breakpoint

ALTER TABLE legal_entities ADD CONSTRAINT legal_entities_org_id_id_uniq UNIQUE (org_id, id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_payments_org_date ON payments (org_id, payment_date);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_vendor_payments_org_date ON vendor_payments (org_id, payment_date);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_exchange_rates_org_date ON fin_exchange_rates (org_id, as_of_date);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_bank_txn_org_date ON fin_bank_transactions (org_id, txn_date);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_bank_transfers_org_date ON fin_bank_transfers (org_id, transfer_date);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_reconciliation_rules_org_priority ON fin_reconciliation_rules (org_id, priority);
