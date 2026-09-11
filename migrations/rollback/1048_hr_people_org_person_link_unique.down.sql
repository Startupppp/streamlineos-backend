-- 1048 DOWN -- drops the hr_people organisation-person link unique.
--
-- Lossless: 1048 creates an index and deletes nothing (it REFUSES on existing
-- duplicates rather than resolving them), so dropping the index returns
-- hr_people to the unconstrained state it is in at journal head today and
-- re-deadens the five 23505 handlers that name this constraint.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS public."uniq_hr_people_org_person_link";
