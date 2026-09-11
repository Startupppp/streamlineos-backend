-- Timesheets: a lifecycle event counter, and the attendance auto-draft opt-in.
--
-- Two additive columns, both `NOT NULL DEFAULT <constant>`, which on PG11+ is a
-- catalog-only change: no table rewrite, so the ACCESS EXCLUSIVE lock is held
-- for a catalog update rather than a scan. The `lock_timeout` is here because
-- the rule is the rule, not because either table is expected to queue.
--
-- 1. `timesheet_periods.event_seq` (TS-05)
--
--    `outbox_events` is UNIQUE on `(organization_id, aggregate_type,
--    aggregate_id, aggregate_version)`. A timesheet period emits an event on
--    every transition — submitted, approved or rejected, locked — and can walk
--    that path more than once because `reopenPeriod` exists. A constant version
--    therefore works exactly once per period and then fails every later
--    transition with a 23505, permanently, for that period.
--
--    Wall-clock millis were the obvious alternative and are wrong here for a
--    concrete reason: `approveSinglePeriod` sets `locked_at` in the same
--    transaction as `status = 'APPROVED'` when `lock_after_approval` is on, so
--    the approved and locked events share one `now` by construction and would
--    collide on their first use.
--
--    The counter is incremented as `event_seq + 1` inside the same UPDATE that
--    performs the transition, so the version and the state change commit
--    together, and two concurrent transitions serialise on the row rather than
--    racing to the same number.
--
--    Existing rows start at 0, which is correct: a period that has never
--    emitted has no versions in use, so its first event takes 1.
--
-- 2. `timesheet_settings.auto_draft_from_attendance` (TS-09)
--
--    FALSE, not TRUE. Attendance and timesheets are allowed to disagree — one
--    records presence, the other records what the work was — and an
--    organisation that clocks people in has not thereby asked for pre-filled
--    draft entries to appear on a timesheet somebody must submit and an
--    approver must sign. Defaulting this on would have written hours nobody
--    entered into every tenant that already uses attendance.

SET lock_timeout = '5s';

ALTER TABLE timesheet_periods
  ADD COLUMN IF NOT EXISTS event_seq integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE timesheet_settings
  ADD COLUMN IF NOT EXISTS auto_draft_from_attendance boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ANALYZE timesheet_periods;
--> statement-breakpoint

ANALYZE timesheet_settings;
