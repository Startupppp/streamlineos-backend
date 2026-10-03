-- Rollback for 1706_timesheet_periods_locked_status_repair — deliberately a no-op.
--
-- 1706 set status = 'LOCKED' on periods that were APPROVED with locked_at already stamped
-- (BUG-TS-BE-012). Those periods were locked; LOCKED is the correct state, and the original
-- APPROVED rows cannot be told apart afterwards from periods locked through the lock route.
-- Reverting would reintroduce the row/event-stream disagreement the migration fixed.

SELECT 1;
