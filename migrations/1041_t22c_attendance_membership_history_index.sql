-- `GET /me/attendance/history` reads one person's own attendance, newest first, a page at a time:
--
--   WHERE org_id = $1 AND user_membership_id = $2  ORDER BY date DESC, created_at DESC  LIMIT $3
--   (AttendanceReadService.history, plus the count(*) over the identical predicate)
--
-- `attendance` carries five indexes and not one of them leads with the membership column. The
-- tenant authority moved to `user_membership_id` (`fk_attendance_user_actor`), the read followed,
-- and the indexes did not: `idx_attendance_org_user_date` is still on the display identity
-- `user_id`. The Drizzle table has declared `idx_attendance_org_user_membership_date` since the
-- actor-contract rollout, but no migration ever created it, so it exists in the schema file and
-- nowhere else. This is that migration.
--
-- MEASURED, not reasoned about. `scratch_perf_seed` rebuilt to head (10,008 attendance rows over
-- four tenants at 9,000 / 900 / 90 / 18 -- 89.93 / 9.00 / 0.90 / 0.18 percent), VACUUM ANALYZEd,
-- probed as `streamline_app` (rolbypassrls = false) with the tenant GUC set, in BUFFERS, warm
-- (fifth of five samples), on every tenant, with the index created and dropped around each run.
--
--   the page read (LIMIT 31), buffers:
--
--   tenant     head   (org, membership, date)   THIS INDEX
--   89.93%      193                        5            5
--    9.00%       25                       17           17
--    0.90%        6                        4            4
--    0.18%        3                        4            3
--
--   the count(*) over the same predicate:  193 / 25 / 6 / 3  ->  3 / 3 / 3 / 3.
--
--   rows read from `attendance` to answer the page:
--
--   89.93%   10,008 -> 17      9.00%   900 -> 15      0.90%   90 -> 12      0.18%   18 -> 4
--
-- At the majority tenant head is a Seq Scan over the whole tenant -- 9,991 rows discarded by the
-- filter to return 17 -- and `attendance-mine`'s `maxScanRows` of 200 is breached at two tenants.
-- The index is chosen on all four and is never worse than head on any of them.
--
-- `created_at DESC` is the fourth key and it is not decoration. Without it the index orders by
-- `date` only, the planner adds an Incremental Sort for the `created_at` tiebreak, and the tiny
-- tenant pays one extra buffer for it (4 against head's 3). With it the ordering is satisfied
-- outright, LIMIT stops after the page, and no tenant is worse than head. Both keys are DESC so
-- the scan runs forward; the pair is what makes the ordering usable, in contrast to 1027, where a
-- key BETWEEN the equality columns and the sort column made it unusable.
--
-- 464 kB against a 1,544 kB heap.

SET lock_timeout = '5s';
--> statement-breakpoint

-- Not CONCURRENTLY: db:migrate runs inside a transaction.
CREATE INDEX IF NOT EXISTS idx_attendance_org_user_membership_date
  ON public.attendance (org_id, user_membership_id, date DESC, created_at DESC);
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class i
    JOIN pg_index x ON x.indexrelid = i.oid
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.relname = 'idx_attendance_org_user_membership_date'
      AND n.nspname = 'public' AND c.relname = 'attendance'
      AND x.indpred IS NULL
      AND (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
             FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum)
          = 'org_id, user_membership_id, date, created_at')
  THEN
    RAISE EXCEPTION
      '1041: idx_attendance_org_user_membership_date is missing, partial, or does not cover (org_id, user_membership_id, date, created_at) — a CREATE INDEX IF NOT EXISTS name collision looks exactly like success';
  END IF;
END
$$;
