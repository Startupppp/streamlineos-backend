SET lock_timeout = '5s';

-- A locked payroll run is a financial record. PAYROLL_LOCKED_STATUSES already
-- refuses adjustments in the service, but nothing stopped a direct write, a
-- script or a future code path from rewriting a snapshot that has been approved,
-- paid or published. These triggers put the same rule at the data layer.
--
-- The parent status is read from payroll_runs, so a cascading delete of the run
-- itself finds no row and is allowed through — the same shape guard_owner_membership
-- relies on.

CREATE OR REPLACE FUNCTION payroll_run_is_locked(p_run_id integer) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM payroll_runs
    WHERE id = p_run_id
      AND status IN ('APPROVED', 'LOCKED', 'PAID', 'PAYSLIPS_PUBLISHED', 'CLOSED')
  );
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_locked_payroll_run_employee() RETURNS trigger AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF payroll_run_is_locked(OLD.run_id) THEN
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
  IF payroll_run_is_locked(target_run) THEN
    RAISE EXCEPTION
      'payroll_line_items are immutable while run % is locked', target_run
      USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$guard$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_locked_payroll_run_employee ON payroll_run_employees;
--> statement-breakpoint

CREATE TRIGGER trg_guard_locked_payroll_run_employee
  BEFORE UPDATE OR DELETE ON payroll_run_employees
  FOR EACH ROW EXECUTE FUNCTION guard_locked_payroll_run_employee();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_locked_payroll_line_item ON payroll_line_items;
--> statement-breakpoint

CREATE TRIGGER trg_guard_locked_payroll_line_item
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_line_items
  FOR EACH ROW EXECUTE FUNCTION guard_locked_payroll_line_item();
