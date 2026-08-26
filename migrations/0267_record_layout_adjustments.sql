-- Ticket 20: where a tenant's arrangement of a record type lives.
--
-- The renderer has taken its layout as data since phase 1, but until now the
-- only layout it could read was the declared one. An administrator who wanted
-- their own column order had nowhere to put it, and the obvious place —
-- `localStorage` — is not per tenant at all, it is per browser: an arrangement
-- one person made would never reach the colleague sitting next to them, and it
-- would pass an isolation test for the wrong reason, because two tenants never
-- collide if nothing is ever shared.
--
-- WHAT IS STORED IS AN OVERLAY, NOT A LAYOUT. A tenant who hides one column this
-- year must still receive the field we add next year. A forked copy of the
-- description would freeze them at the day they touched it, so this table holds
-- only the delta: an order, a hidden set, and the tenant's own groupings.
--
-- Three columns rather than one `adjustment` jsonb. `field_order` and
-- `hidden_fields` are flat lists of field names, which is what `text[]` is for:
-- `NOT NULL DEFAULT '{}'` makes "no order" and "an empty order" ONE state rather
-- than the three a nullable jsonb blob would have (key absent, key null, key
-- `[]`), and `'notes' = ANY(hidden_fields)` answers "does this tenant hide that
-- field" without parsing anything — which is the question asked before a field
-- is ever removed from a description. `groups` is genuinely nested and ordered,
-- a list of `{title, fields[]}`, so it is jsonb; the alternative is a second
-- table and a second transaction for data nothing queries into.
--
-- `updated_by` carries NO foreign key to `users`, and that is deliberate.
-- `scripts/purge-user.mjs` deletes every row whose column references `users`,
-- ignoring the delete rule — so an FK here would erase an entire organisation's
-- screen arrangement on the day the administrator who last saved it is
-- offboarded. 0223 removed exactly this edge from two other tables. The column
-- records who; losing the who is not worth losing the what.
--
-- Every ADD CONSTRAINT is guarded on `pg_constraint` and every foreign key is
-- NOT VALID then VALIDATE, for the reason 0265 sets out: Neon drops
-- connections, and a migration interrupted between the two leaves a constraint
-- that exists NOT VALID, no journal row, and a retry that dies on ADD
-- CONSTRAINT before it ever reaches the VALIDATE that would have finished the
-- job. That is a bad thing to discover during an incident.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "record_layout_adjustments" (
  "adjustment_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" text NOT NULL,
  "layout_key" text NOT NULL,
  "field_order" text[] NOT NULL DEFAULT '{}'::text[],
  "hidden_fields" text[] NOT NULL DEFAULT '{}'::text[],
  "groups" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'record_layout_adjustments_org_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "record_layout_adjustments"
      ADD CONSTRAINT "record_layout_adjustments_org_id_organizations_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "record_layout_adjustments" VALIDATE CONSTRAINT "record_layout_adjustments_org_id_organizations_id_fk";

--> statement-breakpoint
-- One arrangement per record type per tenant. Two would mean the renderer had
-- to pick between them, and there is no rule that could. This is also the
-- conflict target every save upserts onto, so a concurrent second save loses
-- the race in the database rather than in a read-then-write nobody serialises.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniq_record_layout_adjustments_org_layout'
  ) THEN
    ALTER TABLE "record_layout_adjustments"
      ADD CONSTRAINT "uniq_record_layout_adjustments_org_layout" UNIQUE ("org_id", "layout_key");
  END IF;
END $$;

--> statement-breakpoint
-- A tenant table with no policy is readable organisation-wide, because grants
-- arrive through ALTER DEFAULT PRIVILEGES and a missing policy is silent. This
-- exact omission has now been found three times in this phase.
ALTER TABLE "record_layout_adjustments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "record_layout_adjustments";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "record_layout_adjustments"
  FOR ALL USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "record_layout_adjustments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "record_layout_adjustments" TO streamline_app;
