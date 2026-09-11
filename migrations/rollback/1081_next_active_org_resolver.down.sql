-- Rollback for 1081 — fully reversible, no data involved.
--
-- 1081 added one SECURITY DEFINER function and its grants. It creates no table, no column and no
-- row, so dropping it discards nothing a user could observe.
--
-- WHAT THIS BREAKS. OrgLifecycleService.resolveReplacementOrgIds and OrgPurgeService's equivalent
-- call app.next_active_org_ids for the whole departing cohort in one statement. With the function
-- gone, archiving or purging an organisation fails 42883 (function does not exist) at the point
-- where it resolves each member's replacement organisation. Roll the application back to the
-- per-member withIdentity loop in the same change, or archive and purge stop working.

SET lock_timeout = '5s';

DROP FUNCTION IF EXISTS app.next_active_org_ids(text[]);

RESET lock_timeout;
