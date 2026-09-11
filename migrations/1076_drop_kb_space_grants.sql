-- kb_space_grants is removed.
--
-- The table was read in exactly one place (KbAccessService.computeAccessibleSpaceIds) and
-- written in none: no product code path, no controller and no service ever inserted a row,
-- so granting an individual access to a space through it silently did nothing. Space access
-- is carried by kb_space_members, which the members API actually writes, and keeping a second
-- unwritten table alongside it created a second meaning of "who can read this space".
--
-- Dropping is safe because the table can only ever be empty in a database whose rows were
-- produced by the application. Deployments that back-filled it by hand must migrate those
-- rows into kb_space_members BEFORE applying this migration.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS public.kb_space_grants;
