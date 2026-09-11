-- Custom SQL migration file, put your code below! --

-- `inv_customer_returns` too, and the drift that hid it.
--
-- Phase 2, ticket 08. The expand in 0272 was built from `pg_constraint` -- every
-- column with a real foreign key to `clients`. `inv_customer_returns.client_id`
-- is not in that list, because **the database has no such key**: Drizzle
-- declares `.references(() => clients.id)` and no migration ever created it.
--
-- Worth stating plainly, because it means the "sixty-five foreign keys"
-- measurement understated the problem rather than overstating it. A column that
-- points at `clients` in the application's mind but not in the database's is a
-- dependency that blocks the drop just as firmly -- the reader still breaks --
-- while being invisible to the query that counts blockers. It was found by the
-- schema invariant rather than by the catalogue, which is the argument for
-- having both.
--
-- The missing key is deliberately NOT added here. Creating a foreign key that
-- has never existed would fail on any orphaned row, and this migration's job is
-- to unblock the drop rather than to enforce a constraint the contract migration
-- will delete along with the table.

SET lock_timeout = '5s';

ALTER TABLE inv_customer_returns ADD COLUMN IF NOT EXISTS client_party_id text;

UPDATE inv_customer_returns t
   SET client_party_id = m.party_id
  FROM client_party_map m
 WHERE m.client_id = t.client_id
   AND m.organization_id = t.org_id
   AND t.client_party_id IS NULL
   AND t.client_id IS NOT NULL;

ALTER TABLE inv_customer_returns
  DROP CONSTRAINT IF EXISTS fk_inv_customer_returns_client_party_id;
ALTER TABLE inv_customer_returns
  ADD CONSTRAINT fk_inv_customer_returns_client_party_id
  FOREIGN KEY (org_id, client_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE inv_customer_returns VALIDATE CONSTRAINT fk_inv_customer_returns_client_party_id;

CREATE INDEX IF NOT EXISTS idx_inv_customer_returns_client_party_id
  ON inv_customer_returns (org_id, client_party_id);

DROP TRIGGER IF EXISTS trg_inv_customer_returns_party ON inv_customer_returns;
CREATE TRIGGER trg_inv_customer_returns_party
  BEFORE INSERT OR UPDATE OF client_id ON inv_customer_returns
  FOR EACH ROW EXECUTE FUNCTION derive_party_from_client('client_id', 'client_party_id', 'org_id');
