-- Restores 0445's two guard bodies verbatim, reinstating the organisation-purge
-- defect this migration removes. Provided so the chain is reversible, not because
-- reverting is advisable.

SET lock_timeout = '5s';
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
