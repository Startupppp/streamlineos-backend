-- Wave 7 G5: Add product-strategy fields to managed_products
-- Idempotent: all statements use IF NOT EXISTS guards.

ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS vision text;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS mission_statement text;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS target_customer text;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS differentiators text;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS current_phase text;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS target_launch_date timestamptz;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS success_metrics jsonb;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS owner_membership_id integer;

-- Guard the unique constraint on (org_id, managed_product_id) — add only if absent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = 'managed_products'::regclass
    AND    conname  = 'uniq_managed_products_org_pk'
  ) THEN
    ALTER TABLE managed_products
      ADD CONSTRAINT uniq_managed_products_org_pk
      UNIQUE (org_id, managed_product_id);
  END IF;
END;
$$;
