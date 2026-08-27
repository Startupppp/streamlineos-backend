-- Custom SQL migration file, put your code below! --

-- The contract. `leads`, `clients`, `contacts` and `crm_organizations` go.
--
-- Phase 2, ticket 08, and the end of the identity migration that started in
-- 0240. Party has been canonical since 02; these four have been a *derived
-- mirror* of it, and every value they hold is computed from a Party row by
-- `party-legacy-mirror.ts`. Nothing has read them since this phase's reader
-- migration, and as of the writer contract nothing writes them either.
--
-- What made this hard was never the mirror. It was that these tables mint the
-- CRM's **public identifiers**: `leads.id` is in `GET /leads/:leadId` behind a
-- `ParseIntPipe` and in `/crm/leads/[leadId]` in the address bar. 0277 moved the
-- minting to the `*_party_map` tables and detached the sequences with
-- `OWNED BY NONE`, so the numbers survive this migration and every saved link
-- keeps working. The maps are NOT dropped here — they are now the only record of
-- what a record is called.
--
-- The integer columns on other tables (`invoices.client_id`,
-- `support_tickets.client_id`, `deals.lead_id`, …) are also NOT dropped. They
-- still mean something: they resolve through the maps. Only their foreign keys
-- to these four tables go, because that is what `DROP TABLE` refuses on. Keeping
-- the columns is what lets every existing API response keep its shape.

SET lock_timeout = '5s';

/*
  Two guards, because this is not reversible.

  Neither can fire in the environment this was written against — both are for
  the deployment where the assumption turns out not to hold. A migration that
  silently destroys the one row somebody cared about is worse than one that
  refuses to run.
*/
DO $$
DECLARE
  stranded bigint;
  dm_values bigint;
BEGIN
  -- 1. Every legacy row must have a party. A row without one is a record whose
  --    identity was never migrated, and dropping the table destroys it outright
  --    rather than moving it.
  SELECT
    (SELECT count(*) FROM leads l
      WHERE NOT EXISTS (SELECT 1 FROM lead_party_map m WHERE m.lead_id = l.id))
  + (SELECT count(*) FROM clients c
      WHERE NOT EXISTS (SELECT 1 FROM client_party_map m WHERE m.client_id = c.id))
  + (SELECT count(*) FROM contacts k
      WHERE NOT EXISTS (SELECT 1 FROM contact_party_map m WHERE m.contact_id = k.id))
  + (SELECT count(*) FROM crm_organizations o
      WHERE NOT EXISTS (SELECT 1 FROM crm_org_party_map m WHERE m.crm_organization_id = o.id))
  INTO stranded;

  IF stranded > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop: % legacy row(s) have no party. Backfill the maps first — dropping now destroys them.',
      stranded;
  END IF;

  -- 2. `leads.dm_lead_id` is the one legacy column with nowhere in Party to go:
  --    an identifier belonging to an upstream DM system. It is unread and empty
  --    here, so it goes with the table. Anywhere it is populated, that is a
  --    decision somebody has to make rather than one this migration makes for
  --    them.
  SELECT count(dm_lead_id) INTO dm_values FROM leads;

  IF dm_values > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop: % lead(s) carry dm_lead_id, which has no home in Party. Decide where it lives before dropping.',
      dm_values;
  END IF;
END $$;

/*
  The foreign keys that make DROP TABLE refuse.

  Found by querying the catalogue rather than listed, because they were created
  by a dozen migrations across two phases and share no naming convention — and
  because a list written today is wrong the moment somebody adds a table.

  The columns themselves stay. They resolve through the maps.
*/
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname,
           con.conrelid::regclass::text AS tbl,
           con.confrelid::regclass::text AS target
      FROM pg_constraint con
     WHERE con.contype = 'f'
       AND con.confrelid::regclass::text IN ('leads', 'clients', 'contacts', 'crm_organizations')
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
    RAISE NOTICE 'dropped % (% -> %)', c.conname, c.tbl, c.target;
  END LOOP;
END $$;

-- No CASCADE, deliberately. Every dependency was enumerated above; anything left
-- is something nobody knew about, and this should fail rather than take it too.
DROP TABLE contacts;
DROP TABLE clients;
DROP TABLE leads;
DROP TABLE crm_organizations;
