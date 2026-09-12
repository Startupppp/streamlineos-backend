-- @irreversible
-- These columns predate this migration on every live database, so no rollback can tell whether this
-- migration or the live database's own history created them; dropping them would take production's.
SET lock_timeout = '5s';
--> statement-breakpoint
-- Two control-plane child tables carry org_id on every live database and on no cold build:
-- organization_saga_steps (0608) and organization_relocation_checksums (0617). The column arrived
-- outside the chain. No migration adds it, yet main's 1085 and 1087 write RLS policies on it and 1086
-- drops the foreign key saga steps carried. main's own chain fails a cold build at 1085 for this
-- reason (711/716).
--
-- Recreate what production has, as 1086 describes it for saga steps: a NOT NULL text column that the
-- BEFORE INSERT trigger trg_set_org_id copies down from the parent row's organization_id. It lands
-- here, right after the tables exist, so every later migration sees the shape production had when
-- it ran. Every step is guarded, so on a database that already has the column, the constraint and
-- the trigger this changes nothing.
DO $cols$
DECLARE
  t record;
  chk text;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('organization_saga_steps', 'organization_lifecycle_sagas', 'saga_id', 'saga_id'),
      ('organization_relocation_checksums', 'organization_relocations', 'relocation_id', 'relocation_id')
    ) AS v(child, parent, parent_key, child_fk)
  LOOP
    CONTINUE WHEN to_regclass('public.' || t.child) IS NULL;
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS org_id text', t.child);
    EXECUTE format('UPDATE public.%I c SET org_id = p.organization_id FROM public.%I p WHERE p.%I = c.%I AND c.org_id IS NULL',
                   t.child, t.parent, t.parent_key, t.child_fk);
    IF EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid = to_regclass('public.' || t.child) AND attname = 'org_id' AND NOT attnotnull) THEN
      chk := t.child || '_org_id_present';
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (org_id IS NOT NULL) NOT VALID', t.child, chk);
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', t.child, chk);
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN org_id SET NOT NULL', t.child);
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t.child, chk);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.' || t.child) AND tgname = 'trg_set_org_id') THEN
      EXECUTE format('CREATE TRIGGER trg_set_org_id BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent(%L, %L, %L, %L)',
                     t.child, t.parent, t.parent_key, 'organization_id', t.child_fk);
    END IF;
  END LOOP;
END $cols$;
