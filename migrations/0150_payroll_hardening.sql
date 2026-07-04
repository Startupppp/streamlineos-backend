ALTER TYPE "payroll_run_event_type" ADD VALUE IF NOT EXISTS 'BANK_BATCH_SENT';--> statement-breakpoint
ALTER TYPE "payroll_run_event_type" ADD VALUE IF NOT EXISTS 'BANK_ITEM_PAID';--> statement-breakpoint
ALTER TYPE "payroll_run_event_type" ADD VALUE IF NOT EXISTS 'BANK_ITEM_FAILED';--> statement-breakpoint
ALTER TABLE "payroll_policies" ADD COLUMN IF NOT EXISTS "employee_count" integer;--> statement-breakpoint
CREATE OR REPLACE FUNCTION payroll_run_employees_guard_locked() RETURNS trigger AS $$
DECLARE run_status text;
BEGIN
  SELECT status::text INTO run_status FROM payroll_runs WHERE id = COALESCE(NEW.run_id, OLD.run_id);
  IF run_status IN ('LOCKED', 'PAID', 'PAYSLIPS_PUBLISHED', 'CLOSED') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'payroll run % is locked; run employee rows are immutable', COALESCE(NEW.run_id, OLD.run_id);
    END IF;
    IF NEW.calculation_snapshot IS DISTINCT FROM OLD.calculation_snapshot
      OR NEW.inputs_snapshot IS DISTINCT FROM OLD.inputs_snapshot
      OR NEW.gross IS DISTINCT FROM OLD.gross
      OR NEW.net IS DISTINCT FROM OLD.net
      OR NEW.total_deductions IS DISTINCT FROM OLD.total_deductions
      OR NEW.employer_contributions IS DISTINCT FROM OLD.employer_contributions
      OR NEW.paid_days IS DISTINCT FROM OLD.paid_days
      OR NEW.lop_days IS DISTINCT FROM OLD.lop_days
      OR NEW.overtime_hours IS DISTINCT FROM OLD.overtime_hours
      OR NEW.fx_rate IS DISTINCT FROM OLD.fx_rate
      OR NEW.net_payout_currency IS DISTINCT FROM OLD.net_payout_currency
    THEN
      RAISE EXCEPTION 'payroll run % is locked; calculation data is immutable', NEW.run_id;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_payroll_run_employees_guard_locked ON payroll_run_employees;--> statement-breakpoint
CREATE TRIGGER trg_payroll_run_employees_guard_locked
BEFORE UPDATE OR DELETE ON payroll_run_employees
FOR EACH ROW EXECUTE FUNCTION payroll_run_employees_guard_locked();--> statement-breakpoint
CREATE OR REPLACE FUNCTION payroll_line_items_guard_locked() RETURNS trigger AS $$
DECLARE run_status text;
BEGIN
  SELECT status::text INTO run_status FROM payroll_runs WHERE id = COALESCE(NEW.run_id, OLD.run_id);
  IF run_status IN ('LOCKED', 'PAID', 'PAYSLIPS_PUBLISHED', 'CLOSED') THEN
    RAISE EXCEPTION 'payroll run % is locked; line items are immutable', COALESCE(NEW.run_id, OLD.run_id);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_payroll_line_items_guard_locked ON payroll_line_items;--> statement-breakpoint
CREATE TRIGGER trg_payroll_line_items_guard_locked
BEFORE INSERT OR UPDATE OR DELETE ON payroll_line_items
FOR EACH ROW EXECUTE FUNCTION payroll_line_items_guard_locked();
