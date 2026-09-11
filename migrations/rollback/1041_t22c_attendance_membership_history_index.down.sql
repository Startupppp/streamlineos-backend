-- 1041 DOWN -- drops the membership-keyed attendance index. Reverting returns
-- `GET /me/attendance/history` to a Seq Scan of the tenant at the majority tenant: 10,008 rows
-- read and 9,991 discarded by the filter to return 17, 193 buffers against 5, and the same again
-- for the count(*) beside it.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS public.idx_attendance_org_user_membership_date;
