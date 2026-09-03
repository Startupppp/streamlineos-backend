SET lock_timeout = '5s';
--> statement-breakpoint

-- payroll_bank_batch_items had NO natural key. Its only unique constraints were
-- the surrogate primary key and uniq_payroll_bank_batch_items_org_id (org_id, id),
-- which exists solely so the composite tenant foreign keys have something to point
-- at; (batch_id, status) is a plain lookup index. Nothing at the data layer stopped
-- the same run employee being written into a bank file twice, and nothing stopped a
-- second file being generated for a payee whose first instruction was still in
-- flight at the bank. Both shapes are a duplicate payment instruction, and the
-- service-side guard only excluded payees whose earlier item had already reached
-- status PAID -- which is precisely the window a payment sits in while it is
-- irreversible but not yet confirmed.
--
-- Two indexes, because the two shapes are different rules:
--
--   uniq_payroll_bank_batch_items_batch_subject   (org_id, batch_id, run_employee_id)
--     A payee appears at most once in one bank file. Unconditional.
--
--   uniq_payroll_bank_batch_items_live_subject    (org_id, run_employee_id)
--                                                 WHERE status <> 'FAILED'
--     A payee has at most one LIVE payment instruction across every batch of the
--     run. run_employee_id is the primary key of payroll_run_employees and so is
--     already unique per (run, payee), which is what makes the pair sufficient.
--     FAILED is excluded on purpose: a returned payment must be re-issuable in a
--     new batch, and a FAILED row is a historical record, not an instruction.
--     PENDING, SENT, PAID and HELD are all live.
--
-- Both are created without IF NOT EXISTS so a pre-existing duplicate fails the
-- deploy loudly rather than being papered over -- a duplicate row here is money
-- that may have left the account twice and must be reconciled by a human, never
-- silently deduplicated by a migration.

CREATE UNIQUE INDEX uniq_payroll_bank_batch_items_batch_subject
  ON payroll_bank_batch_items (org_id, batch_id, run_employee_id);
--> statement-breakpoint

CREATE UNIQUE INDEX uniq_payroll_bank_batch_items_live_subject
  ON payroll_bank_batch_items (org_id, run_employee_id)
  WHERE status <> 'FAILED';
