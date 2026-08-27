-- Custom SQL migration file, put your code below! --

-- The CRM's integer identifiers outlive the tables that minted them.
--
-- Phase 2, ticket 08. Dropping `leads`, `clients`, `contacts` and
-- `crm_organizations` looked like a schema change until it became clear what
-- those tables actually own: **the CRM's public identifiers.** `leads.id` is a
-- serial integer, and it is in `GET /leads/:leadId` behind a `ParseIntPipe`, in
-- `/crm/leads/[leadId]` in the browser's address bar, and in every link anybody
-- has ever sent a colleague.
--
-- Party's identifier is a UUID. So the obvious drop is not a migration at all --
-- it renames every lead in the product and breaks every stored link.
--
-- The `*_party_map` tables already hold exactly the mapping that avoids it:
-- `(organization_id, lead_id) -> party_id`, populated, and keyed on the integer.
-- They were on the list to be deleted *as part of the seam*. They should not be:
-- they are the only remaining record of what a lead is called, and that is worth
-- keeping long after the table that minted the number is gone.
--
-- Three things have to be true for a map to outlive its table:
--
--   1. **New records still get an integer.** Today it comes from the table's
--      serial. The sequence is ADOPTED rather than replaced -- `OWNED BY NONE`
--      detaches it so `DROP TABLE` cannot take it with them, and numbering
--      continues unbroken from wherever it had reached. A fresh sequence would
--      have to be seeded from `max(id)`, and getting that wrong by one silently
--      reuses an identifier that is already in somebody's URL.
--
--   2. **The map stops depending on the table.** Its foreign key to the legacy
--      row goes; the integer stays as a plain column, which is all it ever
--      needed to be.
--
--   3. **Nothing else changes.** No route, no response, no link. That is the
--      whole point of doing it this way.
--
-- Non-destructive. The tables are still here afterwards.

SET lock_timeout = '5s';

-- 1. Detach the sequences so the drop cannot take them.
ALTER SEQUENCE leads_id_seq OWNED BY NONE;
ALTER SEQUENCE clients_id_seq OWNED BY NONE;
ALTER SEQUENCE contacts_id_seq OWNED BY NONE;
ALTER SEQUENCE crm_organizations_id_seq OWNED BY NONE;

-- 2. The map mints the next identifier now.
ALTER TABLE lead_party_map    ALTER COLUMN lead_id             SET DEFAULT nextval('leads_id_seq');
ALTER TABLE client_party_map  ALTER COLUMN client_id           SET DEFAULT nextval('clients_id_seq');
ALTER TABLE contact_party_map ALTER COLUMN contact_id          SET DEFAULT nextval('contacts_id_seq');
ALTER TABLE crm_org_party_map ALTER COLUMN crm_organization_id SET DEFAULT nextval('crm_organizations_id_seq');

-- 3. The map no longer needs the row to exist.
--
-- Found by name rather than assumed: these constraints were created by several
-- migrations over the phase and do not share a naming convention.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname, con.conrelid::regclass::text AS tbl
      FROM pg_constraint con
     WHERE con.contype = 'f'
       AND con.conrelid::regclass::text IN
           ('lead_party_map','client_party_map','contact_party_map','crm_org_party_map')
       AND con.confrelid::regclass::text IN
           ('leads','clients','contacts','crm_organizations')
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.tbl, c.conname);
    RAISE NOTICE 'dropped % on %', c.conname, c.tbl;
  END LOOP;
END $$;
