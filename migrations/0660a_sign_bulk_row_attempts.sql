-- SIGN-P0-06. A retry budget for a bulk send row.
--
-- Bulk send created and sent every envelope inside the HTTP request that asked
-- for it — up to `bulk_send_max_rows_per_job`, 500 by default, each one a
-- template instantiation and an email. Moving that onto the outbox means the
-- work can be redelivered, and redelivery without a budget is how one
-- permanently failing row turns into an unbounded retry loop that re-sends
-- every envelope beside it.
--
-- `attempts` counts tries per row, not per job, because the failures that
-- matter here are per row: one bad email address in a spreadsheet of five
-- hundred must not stop the other four hundred and ninety-nine, and must not
-- be retried forever either.

ALTER TABLE "sign_bulk_send_rows"
  ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;
