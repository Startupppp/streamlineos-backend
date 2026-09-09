-- Recreates kb_space_grants as it stood before 1076.
-- Rows are not recoverable: the table is restored empty, which matches the only state the
-- application could ever have left it in (nothing wrote to it).
SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.kb_space_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  space_id integer NOT NULL,
  principal_type text NOT NULL DEFAULT 'user',
  principal_id text NOT NULL,
  permission_key text NOT NULL,
  granted_by text REFERENCES public.users (id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_space_grants"
  ON public.kb_space_grants (org_id, space_id, principal_type, principal_id, permission_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_space_grants_principal"
  ON public.kb_space_grants (org_id, principal_type, principal_id);
--> statement-breakpoint
ALTER TABLE public.kb_space_grants
  ADD CONSTRAINT "fk_kb_space_grants_space_id_org"
  FOREIGN KEY (org_id, space_id) REFERENCES public.kb_spaces (org_id, id) ON DELETE CASCADE;
