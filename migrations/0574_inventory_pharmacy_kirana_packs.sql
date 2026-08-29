-- E3 / E4 — the pharmacy and kirana packs' catalogue fields.
--
-- Both packs are off by default (0553), and every column here is additive,
-- defaulted and invisible while its pack is off. A distributor's catalogue does
-- not grow a drug schedule, and a pharmacy's does not grow a weighing mode.
--
-- E3 — pharmacy.
--   `inv_products.mrp_paise` is the SKU's *currently printed* maximum retail
--   price, in integer paise. It is a default, not a snapshot: it moves when the
--   manufacturer reprints. The snapshots are `inv_grn_lines.mrp_paise` — what
--   the cartons said on the day they were received — and `inv_lots.mrp_paise`,
--   which the post transaction carries forward and which a dispense reads. Two
--   batches of one medicine on one shelf routinely carry different MRPs and the
--   older may not be sold at the newer's price, so the ceiling has to be a fact
--   about a batch, written once and never updated. Integer minor units
--   throughout: an MRP is a legal ceiling, and a value that arrives as 12550 and
--   leaves as 125.49999999999999 is not a rounding preference.
--
--   `mrp_required` is what the receipt rule keys on. `drug_schedule`,
--   `is_high_alert` and `lasa_group` are the safety inputs. A LASA *group*
--   rather than a boolean, because "this one is confusable" is useless at the
--   shelf and "this one is confusable with those three" is the whole warning.
--
-- E4 — kirana.
--   `sale_mode` decides whether a sale may name a unit other than the one stock
--   is held in; `quantity_input_mode` and `quantity_precision` decide what an
--   entered quantity may look like. The two are held together by a CHECK because
--   either alone is a setting that reads as configured and does nothing —
--   precision 3 on a WHOLE SKU accepts 1.005 tins, and SCALE at precision 0
--   rejects every reading a scale will ever send.
--
-- `pharmacy_h1_register_enabled` is a jurisdiction switch, default off, and it
-- is deliberately not implied by the pharmacy pack: a hospital store and a
-- retail chemist under one roof answer to different rules. What it gates is an
-- export stub that names the SKUs in scope and states that the dispensing rows
-- are not held here. It buys visibility, never compliance.
--
-- Constraints are added NOT VALID then validated separately so the catalogue is
-- never scanned under ACCESS EXCLUSIVE, and each ADD CONSTRAINT is guarded:
-- this environment re-applies migration files, and a bare ADD beside an
-- IF NOT EXISTS column add fails the whole file on the second run.
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_drug_schedule" AS ENUM ('OTC', 'H', 'H1', 'X', 'NARCOTIC');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_sale_mode" AS ENUM ('PACKED', 'LOOSE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_qty_input_mode" AS ENUM ('WHOLE', 'DECIMAL', 'SCALE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "mrp_paise" bigint;
--> statement-breakpoint
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "mrp_required" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "drug_schedule" "inv_drug_schedule";
--> statement-breakpoint
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "is_high_alert" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "lasa_group" text;
--> statement-breakpoint
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "sale_mode" "inv_sale_mode" DEFAULT 'PACKED' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "quantity_input_mode" "inv_qty_input_mode" DEFAULT 'WHOLE' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "quantity_precision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Zero is refused as well as negative. "Free" and "we have not recorded one"
-- are different answers and NULL already says the second.
DO $$ BEGIN
  ALTER TABLE "inv_products"
    ADD CONSTRAINT "chk_inv_products_mrp_paise_positive"
    CHECK ("mrp_paise" IS NULL OR "mrp_paise" > 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "inv_products" VALIDATE CONSTRAINT "chk_inv_products_mrp_paise_positive";
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_products"
    ADD CONSTRAINT "chk_inv_products_qty_input_precision"
    CHECK (
      ("quantity_input_mode" = 'WHOLE' AND "quantity_precision" = 0)
      OR ("quantity_input_mode" <> 'WHOLE' AND "quantity_precision" BETWEEN 1 AND 4)
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "inv_products" VALIDATE CONSTRAINT "chk_inv_products_qty_input_precision";
--> statement-breakpoint

-- The confusable-set lookup and the register-scope walk. Both partial: outside a
-- pharmacy nothing carries a LASA group or a schedule at all.
CREATE INDEX IF NOT EXISTS "idx_inv_products_org_lasa_group"
  ON "inv_products" ("org_id", "lasa_group") WHERE "lasa_group" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_products_org_drug_schedule"
  ON "inv_products" ("org_id", "drug_schedule") WHERE "drug_schedule" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "inv_lots" ADD COLUMN IF NOT EXISTS "mrp_paise" bigint;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_lots"
    ADD CONSTRAINT "chk_inv_lots_mrp_paise_positive"
    CHECK ("mrp_paise" IS NULL OR "mrp_paise" > 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "inv_lots" VALIDATE CONSTRAINT "chk_inv_lots_mrp_paise_positive";
--> statement-breakpoint

ALTER TABLE "inv_grn_lines" ADD COLUMN IF NOT EXISTS "mrp_paise" bigint;
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" ADD COLUMN IF NOT EXISTS "purchase_rate_paise" bigint;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_grn_lines"
    ADD CONSTRAINT "chk_inv_grn_lines_mrp_paise_positive"
    CHECK ("mrp_paise" IS NULL OR "mrp_paise" > 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" VALIDATE CONSTRAINT "chk_inv_grn_lines_mrp_paise_positive";
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_grn_lines"
    ADD CONSTRAINT "chk_inv_grn_lines_purchase_rate_paise_positive"
    CHECK ("purchase_rate_paise" IS NULL OR "purchase_rate_paise" > 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" VALIDATE CONSTRAINT "chk_inv_grn_lines_purchase_rate_paise_positive";
--> statement-breakpoint

ALTER TABLE "inv_settings"
  ADD COLUMN IF NOT EXISTS "pharmacy_h1_register_enabled" boolean DEFAULT false NOT NULL;
