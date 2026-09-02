-- Forward correction to 0445. Its two guards block an organisation purge.
--
-- cron-org-purge-worker.service.ts:241 deletes the organisation row inside one
-- transaction and relies on org_id ON DELETE CASCADE to remove every child.
-- payroll_run_employees and payroll_line_items are each reached that way while
-- their payroll_runs parent is still present, so payroll_run_is_locked(run_id) is
-- still true and the BEFORE DELETE guard raises 23514. The purge aborts.
--
-- 0445's header says the guard is safe because "a cascading delete of the run
-- itself finds no row and is allowed through". That is true of a cascade FROM the
-- run. It is not true of a cascade from the organisation, which reaches the child
-- and the run as siblings: whether the run happens to be deleted first is a
-- function of foreign-key trigger order, not of anything the caller controls.
-- Reproduced on a scratch database at head:
--
--   DELETE FROM organizations WHERE id = '<org with a PAID run>'
--   ERROR:  payroll_run_employees row 2 is immutable while run 3 is locked
--   CONTEXT:  PL/pgSQL function guard_locked_payroll_run_employee() line 5
--   SQL statement "DELETE FROM ONLY public.payroll_run_employees WHERE $1 = org_id"
--
-- The fix adds the same organisation-presence test 1001 uses. Nothing else about
-- either guard changes: an UPDATE always sees its organisation present, so the
-- immutability rule for a locked run is exactly as strict as it was, and a DELETE
-- is still refused for every caller except a cascade whose parent has already gone.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_locked_payroll_run_employee() RETURNS trigger AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF payroll_run_is_locked(OLD.run_id) AND payroll_org_still_present(OLD.org_id) THEN
      RAISE EXCEPTION
        'payroll_run_employees row % is immutable while run % is locked', OLD.id, OLD.run_id
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF payroll_run_is_locked(NEW.run_id)
     AND (
       NEW.calculation_snapshot IS DISTINCT FROM OLD.calculation_snapshot
       OR NEW.inputs_snapshot        IS DISTINCT FROM OLD.inputs_snapshot
       OR NEW.gross                  IS DISTINCT FROM OLD.gross
       OR NEW.net                    IS DISTINCT FROM OLD.net
       OR NEW.total_deductions       IS DISTINCT FROM OLD.total_deductions
       OR NEW.employer_contributions IS DISTINCT FROM OLD.employer_contributions
       OR NEW.scheduled_days         IS DISTINCT FROM OLD.scheduled_days
       OR NEW.paid_days              IS DISTINCT FROM OLD.paid_days
       OR NEW.lop_days               IS DISTINCT FROM OLD.lop_days
       OR NEW.overtime_hours         IS DISTINCT FROM OLD.overtime_hours
       OR NEW.run_id                 IS DISTINCT FROM OLD.run_id
       OR NEW.org_id                 IS DISTINCT FROM OLD.org_id
     )
  THEN
    RAISE EXCEPTION
      'payroll_run_employees row % is immutable while run % is locked', OLD.id, NEW.run_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$guard$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_locked_payroll_line_item() RETURNS trigger AS $guard$
DECLARE target_run integer;
BEGIN
  target_run := COALESCE(NEW.run_id, OLD.run_id);
  IF payroll_run_is_locked(target_run)
     AND payroll_org_still_present(COALESCE(NEW.org_id, OLD.org_id))
     AND (TG_OP <> 'DELETE'
          OR EXISTS (SELECT 1 FROM payroll_run_employees WHERE id = OLD.run_employee_id))
  THEN
    RAISE EXCEPTION
      'payroll_line_items are immutable while run % is locked', target_run
      USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$guard$ LANGUAGE plpgsql;
