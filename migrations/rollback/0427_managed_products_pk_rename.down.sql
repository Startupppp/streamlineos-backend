-- Rollback for 0427. Catalog-only rename back; no data movement.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'managed_products' AND column_name = 'id'
  ) THEN
    ALTER TABLE managed_products RENAME COLUMN id TO managed_product_id;
  END IF;
END $$;
