-- 1075 DOWN — drops the org-scope uniqueness and returns user_integration_connections to the
-- shape it had at journal head 1074.
--
-- @reopens-a-defect: with the index gone, nothing stops a second `scope = 'org'` row for the
-- same `(org_id, toolkit)`. `OrgConnectionsService.replace` still deletes the incumbent inside
-- its transaction, so the single-row invariant survives the ordinary path — but two admins
-- finalising concurrently both commit, `resolveToolkitConnection`'s org fallback then returns
-- whichever row sorts first, and every huddle Meet link in the organisation silently lands in
-- one of two Google accounts depending on `created_at`. The 409 in `replace` becomes
-- unreachable code, because `isUniqueViolation` can no longer fire for this shape.
--
-- REVERTING THE CODE IS OPTIONAL HERE, unlike a column drop: the application reads and writes
-- no index by name, so `org-connections.service.ts` and `connection-resolution.ts` keep
-- compiling and serving. Only the concurrency guarantee is lost. If the code is reverted too,
-- delete the `uniqueIndex(...)` in `src/db/schema/common/integrations.ts` in the same change or
-- the next `db:generate` re-proposes this index.
--
-- NO DATA LOSS: an index carries no rows of its own.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "uq_integration_connections_org_scoped_toolkit";
