-- The member list of a large organization reads every row to return a page.
--
-- Found by the load driver, not by the read-cost budget. Against the 100,004-member fixture,
-- the declared list surface returns 50 rows and the plan is:
--
--   Limit  (actual rows=50)
--     ->  Sort  Sort Key: joined_at DESC  Sort Method: top-N heapsort
--           ->  Bitmap Heap Scan on organization_members  (actual rows=100004)
--                 Heap Blocks: exact=1431   Buffers: shared hit=1513
--
-- 1,513 buffers is inside the declared 5,000 ceiling, which is why org-members-list passes as
-- a read-cost budget. The budget measures blocks; it cannot see that the query materialises the
-- whole tenant to hand back a page, so the cost is linear in organization size and the ceiling
-- is only survivable because 100,000 members is the largest fixture that exists.
--
-- (org_id, joined_at DESC) lets the planner walk the sort order and stop at the LIMIT.
-- org_id leads because the RLS policy is predicated on it: an index that omits the tenant
-- column cannot serve a query the policy rewrites.

CREATE INDEX IF NOT EXISTS "idx_org_members_org_joined"
  ON "organization_members" ("org_id", "joined_at" DESC);
