-- 0304: convert free-text status columns to Postgres enums (audit S-18).
-- inv_stock_adjustments.status -> inv_adjustment_status
-- inv_vendor_returns.status & inv_customer_returns.status -> inv_return_status
-- Preflight verified: all three tables have no rows with values outside the enums.
-- Enum values are the SUPERSET of what services write AND what the list DTOs filter by
-- (adjustments includes legacy DRAFT + real PENDING_POST) so no insert or filter can fail.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inv_adjustment_status') THEN
    CREATE TYPE inv_adjustment_status AS ENUM ('DRAFT','PENDING_APPROVAL','APPROVED','PENDING_POST','POSTED','CANCELLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inv_return_status') THEN
    CREATE TYPE inv_return_status AS ENUM ('DRAFT','POSTED','CANCELLED');
  END IF;
END $$;

ALTER TABLE inv_stock_adjustments ALTER COLUMN status DROP DEFAULT;
ALTER TABLE inv_stock_adjustments ALTER COLUMN status TYPE inv_adjustment_status USING status::inv_adjustment_status;
ALTER TABLE inv_stock_adjustments ALTER COLUMN status SET DEFAULT 'POSTED';

ALTER TABLE inv_vendor_returns ALTER COLUMN status DROP DEFAULT;
ALTER TABLE inv_vendor_returns ALTER COLUMN status TYPE inv_return_status USING status::inv_return_status;
ALTER TABLE inv_vendor_returns ALTER COLUMN status SET DEFAULT 'DRAFT';

ALTER TABLE inv_customer_returns ALTER COLUMN status DROP DEFAULT;
ALTER TABLE inv_customer_returns ALTER COLUMN status TYPE inv_return_status USING status::inv_return_status;
ALTER TABLE inv_customer_returns ALTER COLUMN status SET DEFAULT 'DRAFT';
