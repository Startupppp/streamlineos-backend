-- 0589: NEO-15's one drop candidate, dropped.
--
-- `inv_reason_codes` arrived in 0407 to replace a fixed enum, and nothing was
-- ever built on top of it. It has no service, no controller, no frontend route
-- and no foreign key pointing at it; adjustments record their reason as an enum
-- and a free-text note, which is what they did before 0407 and what they still
-- do. The only reference anywhere in the repository was an RLS spec asserting
-- isolation on a table nobody reads.
--
-- The bar for dropping it was "zero live rows or a proven archive". It is zero
-- in every tenant on the only database carrying real ones, and it is zero by
-- construction rather than by luck: **the sole writer that ever existed is
-- 0407's own seed**, a one-shot `INSERT ... FROM organizations` that fired once
-- against the organisations present at that moment. No org-creation path writes
-- reason codes, so every organisation made since 0407 has none and always will.
-- A table that cannot become non-empty through any product action, and that
-- nothing reads, is not configuration anybody is keeping.
--
-- ## Guarded, and why the guard is not theatre
--
-- The count above is what this session can see. A deployment it cannot see —
-- one whose organisations predate 0407 and inherited the eight seeded codes —
-- would have rows that are somebody's configuration, and losing them to a
-- migration written from someone else's empty database is exactly the failure
-- this repository asks migrations to be careful about. So the drop declines
-- there, loudly, and leaves the table exactly as it was: unread by the code,
-- which is the state it has been in since it was created.
--
-- The type `inv_reason_category` is deliberately left in place. Dropping a type
-- is a separate hazard for one line of catalogue, 0545's comment still refers to
-- it by name, and nothing is gained.

SET lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.inv_reason_codes') IS NULL THEN
    RAISE NOTICE '0589: inv_reason_codes is already gone; nothing to do.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM "inv_reason_codes") THEN
    RAISE NOTICE
      '0589: inv_reason_codes holds rows on this database, so it is kept. Nothing in the application reads it; those rows are configuration somebody entered and this migration will not delete them.';
    RETURN;
  END IF;

  DROP TABLE "inv_reason_codes";
  RAISE NOTICE '0589: inv_reason_codes dropped (it was empty).';
END $$;
