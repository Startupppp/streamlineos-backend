-- 0533 — rebuild what 0529 installed, by the three rules 0529 skipped.
--
-- `0529_ledger_corrections_and_immutability.sql` is right about what the ledger
-- needs and wrong about how to install it on a table that is being written to:
--
--   1. it sets no `lock_timeout`, so it queues behind any long read on
--      `inv_stock_transactions` instead of failing fast (0528, 0530 and 0531 all
--      set one);
--   2. it adds the composite foreign key with a bare `ADD CONSTRAINT … FOREIGN
--      KEY`, which takes ACCESS EXCLUSIVE on *both* sides — and both sides are
--      the ledger — for the whole validating scan, rather than the
--      `NOT VALID` → `VALIDATE CONSTRAINT` split §3 Migrations requires;
--   3. it builds a unique index non-concurrently, which holds SHARE for the
--      whole build and blocks every write to the ledger while it runs.
--
-- 0529 is applied, and editing an applied migration changes its hash, so the
-- repair is a new file rather than a correction to that one.
--
-- ---------------------------------------------------------------------------
-- WHY THIS FILE LOOKS LIKE A SET OF ASSERTIONS RATHER THAN A REBUILD
-- ---------------------------------------------------------------------------
-- The runner is `drizzle-orm`'s `PgDialect.migrate`, and it wraps **every
-- pending migration together in a single transaction** (`session.transaction`,
-- one `tx.execute` per statement). Two consequences decide the shape of this
-- file:
--
--   * `CREATE INDEX CONCURRENTLY` and `REINDEX … CONCURRENTLY` cannot run
--     inside a transaction block at all, so neither can appear here. That is
--     the same constraint 0374, 0434, 0475, 0497 and 0501 each ran into, and
--     they resolved it the same way: the plain form in the file, guarded with
--     `IF NOT EXISTS`, and the concurrent form run by hand against the live
--     database first, after which the guard makes the file a no-op.
--   * The `NOT VALID` → `VALIDATE` split only buys anything when the two halves
--     are in *different* transactions. In one transaction the ACCESS EXCLUSIVE
--     lock taken by the `ADD` is held until commit, so an unguarded
--     drop-and-recreate here would reproduce precisely the outage it is meant
--     to repair, on a table with 32k rows today and more later.
--
-- So the live rebuild was performed out of transaction, one statement per
-- transaction, against the shared database, exactly as below:
--
--   SET lock_timeout = '5s';
--   ALTER TABLE inv_stock_transactions
--     DROP CONSTRAINT fk_inv_stock_transactions_correction_of_org;
--   -- catalogue-only, no scan, ACCESS EXCLUSIVE held for microseconds:
--   ALTER TABLE inv_stock_transactions
--     ADD CONSTRAINT fk_inv_stock_transactions_correction_of_org
--     FOREIGN KEY (org_id, correction_of_transaction_id)
--     REFERENCES inv_stock_transactions (org_id, id)
--     ON DELETE RESTRICT NOT VALID;
--   -- SHARE UPDATE EXCLUSIVE, concurrent with reads and writes:
--   ALTER TABLE inv_stock_transactions
--     VALIDATE CONSTRAINT fk_inv_stock_transactions_correction_of_org;
--   -- SHARE UPDATE EXCLUSIVE, and never leaves the table without its unique
--   -- index the way DROP + CREATE CONCURRENTLY would:
--   REINDEX INDEX CONCURRENTLY uniq_inv_stock_transactions_correction_of;
--   REINDEX INDEX CONCURRENTLY idx_inv_stock_transactions_correction_source;
--
-- What remains below is the part a migration can carry: the `lock_timeout` that
-- 0529 never set, and the intended end state expressed so that any database
-- missing or half-holding these objects converges on it. On the shared database
-- and on a cold build it is a no-op, which is the correct outcome — the objects
-- 0529 produced are the right objects; only the locks it took to produce them
-- were wrong, and no later migration can un-take a lock.

SET lock_timeout = '5s';
--> statement-breakpoint

-- The correction link, installed the two-step way on any database that is
-- missing it. `NOT VALID` first so the `ADD` never scans under ACCESS
-- EXCLUSIVE; the validation is its own statement below.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_inv_stock_transactions_correction_of_org'
       AND conrelid = 'inv_stock_transactions'::regclass
  ) THEN
    ALTER TABLE inv_stock_transactions
      ADD CONSTRAINT fk_inv_stock_transactions_correction_of_org
      FOREIGN KEY (org_id, correction_of_transaction_id)
      REFERENCES inv_stock_transactions (org_id, id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

-- Validation only where it is still outstanding, so a database that already
-- holds the validated constraint is not made to rescan the ledger for nothing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_inv_stock_transactions_correction_of_org'
       AND conrelid = 'inv_stock_transactions'::regclass
       AND NOT convalidated
  ) THEN
    ALTER TABLE inv_stock_transactions
      VALIDATE CONSTRAINT fk_inv_stock_transactions_correction_of_org;
  END IF;
END $$;
--> statement-breakpoint

-- The two indexes, as they are meant to stand. Not CONCURRENTLY, for the reason
-- in the header; on a populated database the `REINDEX … CONCURRENTLY` above has
-- already run and `IF NOT EXISTS` makes both of these no-ops.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_stock_transactions_correction_of
  ON inv_stock_transactions (org_id, correction_of_transaction_id)
  WHERE correction_of_transaction_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_inv_stock_transactions_correction_source
  ON inv_stock_transactions (org_id, id)
  WHERE correction_of_transaction_id IS NOT NULL;
