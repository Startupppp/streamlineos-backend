-- inv_stock_transactions carries eight foreign keys where six are load-bearing.
-- Two child columns are constrained twice against the same parent -- once by a
-- single-column key and once by the canonical organisation-scoped composite:
--
--   product_variant_id -> inv_product_variants   single CASCADE  / composite NO ACTION
--   location_id        -> inv_locations          single SET NULL / composite NO ACTION
--
-- Every FK is a row trigger and a FOR KEY SHARE lock on the parent, so a 1,000-row
-- insert fires 8,000 trigger invocations and takes 8,000 parent key-share locks
-- where 6,000 suffice. That is 2,000 redundant invocations and 2,000 redundant
-- locks per 1,000 rows on the hottest write path in inventory. The single-column
-- halves also let a row in one organisation reference a parent in another, which
-- is the tenancy hole the composites exist to close.
--
-- The referential action is MOVED onto the composite rather than dropped with the
-- constraint that carried it. Dropping the CASCADE twin outright would turn a
-- variant delete into a 23503; dropping the SET NULL twin outright would turn a
-- location delete into a 23503 instead of clearing the pointer. Behaviour after
-- this migration is identical to behaviour before it.
--
-- location_id is nullable and org_id is NOT NULL, so the SET NULL composite takes
-- an explicit column list naming only location_id. A bare composite SET NULL would
-- try to null the tenant column and raise 23502 on every location delete -- the
-- defect 0770 swept, 0992 repaired and 0995 documented.
--
-- product_variant_id is NOT NULL, which is why its composite takes CASCADE and not
-- SET NULL: there is no nullable member to clear.
--
-- No trigger is added or altered. The organisation purge reaches this table through
-- its own org_id CASCADE to organizations, which this file does not touch, so
-- cron-org-purge-worker is unaffected -- verified by running the purge, not by reading:
-- DELETE FROM organizations leaves 0 rows here, because the cascade DELETEs the
-- transaction rather than updating it.
--
-- A PRE-EXISTING DEFECT THIS FILE PRESERVES RATHER THAN INTRODUCES, recorded because
-- the next person to touch these constraints will meet it. inv_stock_transactions
-- carries the BEFORE UPDATE guard inv_stock_transactions_no_restatement(), which lists
-- location_id among the append-only columns. ON DELETE SET NULL is implemented as an
-- UPDATE, so deleting an inv_locations row that any posted movement points at raises
--
--   ERROR: inv_stock_transactions is append-only: location_id cannot be changed on
--          posted movement <id>   (23514)
--
-- That is already true at head with the single-column ON DELETE SET NULL constraint --
-- reproduced on a database WITHOUT this migration -- so behaviour is unchanged either
-- way, and this file deliberately mirrors the existing action rather than quietly
-- resolving the conflict. The guard is UPDATE-only, which is why the organisation
-- purge is unaffected while a direct location delete is not. Resolving it means
-- choosing between RESTRICT (refuse the location delete honestly) and exempting
-- location_id from the append-only set, and that is an inventory ledger decision.

-- AMENDED 2026-09-04, resealed deliberately under check:migration-immutability --reseal.
-- The closing assertion demanded a total of 7 foreign keys and could therefore never
-- succeed on an empty database: a cold build carries 8 here, this file drops 2, and 6
-- remain -- which is exactly the "six are load-bearing" this file's own header opens with.
-- It passed only against a warm database carrying inv_stock_transactions.handling_unit_id
-- and its foreign key to inv_handling_units, which no migration creates, no Drizzle schema
-- declares and nothing under src/ references: db:push residue, counted as if it were schema.
-- Four clean bootstraps stopped here at 654/685. A total-count assertion breaks on any
-- unrelated extra key, so the check now names the six load-bearing constraints it actually
-- depends on and no longer cares what else the table carries.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE inv_stock_transactions
  DROP CONSTRAINT IF EXISTS inv_stock_transactions_product_variant_id_inv_product_variants_;
--> statement-breakpoint

ALTER TABLE inv_stock_transactions
  DROP CONSTRAINT IF EXISTS fk_inv_stock_transactions_product_variant_id_org;
--> statement-breakpoint

ALTER TABLE inv_stock_transactions
  ADD CONSTRAINT fk_inv_stock_transactions_product_variant_id_org
  FOREIGN KEY (org_id, product_variant_id)
  REFERENCES inv_product_variants (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_stock_transactions VALIDATE CONSTRAINT fk_inv_stock_transactions_product_variant_id_org;
--> statement-breakpoint

ALTER TABLE inv_stock_transactions
  DROP CONSTRAINT IF EXISTS inv_stock_transactions_location_id_inv_locations_id_fk;
--> statement-breakpoint

ALTER TABLE inv_stock_transactions
  DROP CONSTRAINT IF EXISTS fk_inv_stock_transactions_location_id_org;
--> statement-breakpoint

ALTER TABLE inv_stock_transactions
  ADD CONSTRAINT fk_inv_stock_transactions_location_id_org
  FOREIGN KEY (org_id, location_id)
  REFERENCES inv_locations (org_id, id)
  ON DELETE SET NULL (location_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_stock_transactions VALIDATE CONSTRAINT fk_inv_stock_transactions_location_id_org;
--> statement-breakpoint

DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(con.conname, ', ' ORDER BY con.conname)
    INTO offenders
    FROM pg_constraint con
   WHERE con.conname IN (
           'inv_stock_transactions_product_variant_id_inv_product_variants_',
           'inv_stock_transactions_location_id_inv_locations_id_fk');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'redundant single-column foreign keys survived the drop: %', offenders;
  END IF;

  SELECT string_agg(con.conname, ', ' ORDER BY con.conname)
    INTO offenders
    FROM pg_constraint con
   WHERE con.conname IN (
           'fk_inv_stock_transactions_product_variant_id_org',
           'fk_inv_stock_transactions_location_id_org')
     AND (
       con.convalidated IS NOT TRUE
       OR EXISTS (
         SELECT 1
           FROM unnest(COALESCE(con.confdelsetcols, ARRAY[]::smallint[])) z(attnum)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = z.attnum
          WHERE a.attnotnull)
       OR (con.confdeltype = 'n' AND con.confdelsetcols IS NULL));

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'composite foreign keys left in an unusable shape: %', offenders;
  END IF;

  SELECT string_agg(required.conname, ', ' ORDER BY required.conname)
    INTO offenders
    FROM unnest(ARRAY[
           'fk_inv_stock_transactions_correction_of_org',
           'fk_inv_stock_transactions_location_id_org',
           'fk_inv_stock_transactions_product_variant_id_org',
           'fk_inv_stock_txn_cre_mbr',
           'inv_stock_transactions_created_by_users_id_fk',
           'inv_stock_transactions_org_id_organizations_id_fk'
         ]) AS required(conname)
   WHERE NOT EXISTS (
           SELECT 1
             FROM pg_constraint con
             JOIN pg_class c ON c.oid = con.conrelid
            WHERE con.contype = 'f'
              AND c.relname = 'inv_stock_transactions'
              AND con.conname = required.conname);

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'load-bearing foreign keys missing from inv_stock_transactions: %', offenders;
  END IF;
END $$;
