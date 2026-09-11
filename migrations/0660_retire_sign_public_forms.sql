SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0660 — retire the e-sign public forms feature.
--
-- Both halves were unreachable. The anonymous consumer
-- (`GET/POST /public/sign/forms/:slug`) had no caller on any frontend
-- branch, and its only writer, `POST /sign/templates/:id/publish-public-form`,
-- had none either. With no way to publish a form, every anonymous request
-- 404'd on the missing row — the feature was inert, but inert by the absence
-- of data rather than by a guard, while still exposing an unauthenticated
-- endpoint that instantiated envelopes and minted signing tokens.
--
-- Dropping the table drops its `tenant_isolation` policy with it, which is how
-- the public-token read arm 0384 gave this table is retired. 0384 itself is
-- NOT edited: it is applied history, and it is catalog-driven — its DO block
-- looks the table up in pg_class and skips with a NOTICE when it is absent, so
-- a cold replay stays green in either order.
--
-- `sign_recipients` keeps its sibling arm on `signing_token_hash`. That one is
-- load-bearing: it is how a real signer's token resolves its org before any
-- tenant context exists, and it backs the live signing flow. Nothing below
-- touches it.

DO $$
DECLARE
  form_rows bigint := 0;
  linked_envelopes bigint := 0;
BEGIN
  IF to_regclass('public.sign_public_forms') IS NOT NULL THEN
    -- Migrations run as the table owner and this table is ENABLE (not FORCE)
    -- ROW LEVEL SECURITY, so this count sees every tenant's rows.
    EXECUTE 'SELECT count(*) FROM public.sign_public_forms' INTO form_rows;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'sign_envelopes'
      AND a.attname = 'public_form_id' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    EXECUTE 'SELECT count(*) FROM public.sign_envelopes WHERE public_form_id IS NOT NULL'
      INTO linked_envelopes;
  END IF;

  -- Both are expected to be zero: no shipped code path ever wrote either one
  -- (`public_form_id` was declared in the Drizzle schema and never assigned).
  -- A non-zero count means the premise this removal rests on is wrong and
  -- someone reached the feature after all, so stop rather than destroy it.
  IF form_rows > 0 OR linked_envelopes > 0 THEN
    RAISE EXCEPTION
      'refusing to drop sign_public_forms: % form row(s), % linked envelope(s). '
      'The feature was believed unreachable; this data says otherwise. Preserve '
      'or export these rows and decide deliberately before re-running.',
      form_rows, linked_envelopes;
  END IF;
END $$;
--> statement-breakpoint

-- Discover the FK by catalog rather than by name: a chain-repair replay can
-- install this constraint under a generated name.
DO $$
DECLARE
  con record;
BEGIN
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
      AND t.relname = 'sign_envelopes'
      AND c.confrelid = to_regclass('public.sign_public_forms')
  LOOP
    EXECUTE format('ALTER TABLE public.sign_envelopes DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;
--> statement-breakpoint

ALTER TABLE "sign_envelopes" DROP COLUMN IF EXISTS "public_form_id";
--> statement-breakpoint

-- No CASCADE: the only dependent was the FK dropped above, so an unexpected
-- dependency should fail loudly here instead of being silently destroyed.
DROP TABLE IF EXISTS "sign_public_forms";
--> statement-breakpoint

-- The enum backed only sign_public_forms.status.
DROP TYPE IF EXISTS "public"."sign_public_form_status";
