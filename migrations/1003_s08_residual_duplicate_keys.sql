-- The residue of the S14/S15 index minimisation that 0999 left behind, found by
-- re-deriving both relationships from pg_index on a database at head rather than
-- from 0999's own list.
--
-- Part 1 -- nine exact-duplicate tenant anchors. Each of these nine tables carries
-- TWO unique constraints over the identical (tenant, id) column pair under two
-- different names. A duplicate unique costs a second index write on every INSERT
-- and UPDATE of the table, a second entry in the visibility map, its own bloat and
-- its own VACUUM, and answers no read the survivor cannot. The survivor in every
-- pair is the one composite foreign keys already point at, read from
-- pg_constraint.conindid: 50 of them for business_parties, 8 for workers, 3 each
-- for party_contacts, custom_field_definitions and legal_entities, 2 each for
-- organization_people, portal_memberships and principal_groups, 1 for
-- user_delegations. The dropped member has zero dependants in every case, so no
-- foreign key changes which index enforces it.
--
-- user_delegations is the one pair where the survivor is the member Drizzle did
-- NOT declare, so db/schema/common/auth-delegations.ts moves its declaration to
-- uniq_user_delegations_org_id in the same change. For the other eight the dropped
-- member was undeclared, which is why 0999's declaration-driven pass did not see
-- them.
--
-- Part 2 -- six prefix-redundant indexes. (org_id, date) against
-- (org_id, date DESC, id DESC) on the same table: a btree is scannable in both
-- directions, so the wider index serves every predicate and every ordering the
-- narrower one can, including the ascending scan. 0999 missed these because a
-- column-list parser that stops at the first ')' mis-reads a definition carrying
-- a direction modifier.
--
-- Nothing here is dropped because it looked unused. pg_stat_user_indexes on a
-- bootstrapped database measures the bootstrap; every row below is either
-- bit-identical to a surviving index on the same table or answerable from a wider
-- one by definition of a btree.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE user_delegations DROP CONSTRAINT IF EXISTS uniq_user_delegations_org_delegation;
--> statement-breakpoint

ALTER TABLE organization_people DROP CONSTRAINT IF EXISTS uniq_organization_people_org_id;
--> statement-breakpoint

ALTER TABLE workers DROP CONSTRAINT IF EXISTS uniq_workers_org_id;
--> statement-breakpoint

ALTER TABLE business_parties DROP CONSTRAINT IF EXISTS uniq_business_parties_org_id;
--> statement-breakpoint

ALTER TABLE party_contacts DROP CONSTRAINT IF EXISTS uniq_party_contacts_org_id;
--> statement-breakpoint

ALTER TABLE portal_memberships DROP CONSTRAINT IF EXISTS uniq_portal_memberships_org_id;
--> statement-breakpoint

ALTER TABLE principal_groups DROP CONSTRAINT IF EXISTS principal_groups_org_id_id_uniq;
--> statement-breakpoint

ALTER TABLE custom_field_definitions DROP CONSTRAINT IF EXISTS uniq_custom_field_definitions_org_id;
--> statement-breakpoint

ALTER TABLE legal_entities DROP CONSTRAINT IF EXISTS legal_entities_org_id_id_uniq;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_payments_org_date;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_vendor_payments_org_date;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_fin_exchange_rates_org_date;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_fin_bank_txn_org_date;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_fin_bank_transfers_org_date;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_fin_reconciliation_rules_org_priority;
--> statement-breakpoint

DO $$
DECLARE surviving text;
BEGIN
  SELECT string_agg(t.name, ', ') INTO surviving
  FROM (VALUES
    ('uniq_user_delegations_org_id'),
    ('uniq_org_people_org_person'),
    ('uniq_workers_org_worker'),
    ('uniq_business_parties_org_party'),
    ('uniq_party_contacts_org_contact'),
    ('uniq_portal_memberships_org_membership'),
    ('uniq_principal_groups_org_id'),
    ('uniq_cfd_org_id'),
    ('uniq_legal_entities_org_id'),
    ('idx_payments_org_date_id'),
    ('idx_vendor_payments_org_date_id'),
    ('idx_fin_exchange_rates_as_of_date_id'),
    ('idx_fin_bank_transactions_txn_date_id'),
    ('idx_fin_bank_transfers_date_id'),
    ('idx_fin_reconciliation_rules_priority_id')
  ) AS t(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = t.name AND c.relkind = 'i');
  IF surviving IS NOT NULL THEN
    RAISE EXCEPTION 'S14/S15 residue drop removed an index it was meant to keep: %', surviving;
  END IF;
END $$;
