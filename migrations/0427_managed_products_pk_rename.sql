-- 0427: PM-014 — rename managed_products.managed_product_id to id.
--
-- Every other table in the product names its surrogate key `id`; this one did not, so callers had to
-- remember a per-table exception and generic helpers that assume `id` silently did not apply to it.
--
-- RENAME COLUMN is catalog-only: foreign keys, indexes and constraints track the column by attnum, so
-- the 4 inbound references follow automatically and no data is rewritten. Child tables keep their own
-- `managed_product_id` FK column name, which is correct — that names the relationship, not the key.
--
-- Idempotent: skipped when the rename has already happened.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'managed_products'
      AND column_name = 'managed_product_id'
  ) THEN
    ALTER TABLE managed_products RENAME COLUMN managed_product_id TO id;
  END IF;
END $$;
