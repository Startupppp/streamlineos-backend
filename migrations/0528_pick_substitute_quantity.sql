SET lock_timeout = '5s';
--> statement-breakpoint
-- INV-205 recorded a substitution by adding the substitute's quantity to the
-- line's `quantity_picked` -- but the line names the *original* variant, so
-- every downstream reader counted those units as if the original SKU had been
-- picked.
--
-- The concrete damage: packages.service builds its picked-quantity map keyed on
-- `product_variant_id`, so closing a package containing 5 of A was permitted
-- when 5 of B had actually been picked, and a package containing the B that is
-- really in the tote was rejected. so-fulfillment's all-picked check and
-- INV-210's confirmed-line count read the same phantom units.
--
-- The substitute quantity gets its own column. `quantity_picked` goes back to
-- meaning what it says: how much of this line's variant was picked.
ALTER TABLE "inv_pick_list_lines"
  ADD COLUMN IF NOT EXISTS "substitute_quantity" numeric(18, 4);
--> statement-breakpoint
DO $$
BEGIN
  -- A substitute quantity without a substitute variant is not a substitution,
  -- and a substitute variant without a quantity records that something was
  -- swapped while forgetting how much.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_pick_lines_substitute_pair'
  ) THEN
    ALTER TABLE "inv_pick_list_lines"
      ADD CONSTRAINT "chk_inv_pick_lines_substitute_pair" CHECK (
        ("substitute_variant_id" IS NULL AND "substitute_quantity" IS NULL)
        OR ("substitute_variant_id" IS NOT NULL AND "substitute_quantity" IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;
