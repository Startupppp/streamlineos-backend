-- E2 — HSN and tax treatment on the SKU, snapshotted onto document lines.
--
-- Inventory stores the tax *inputs* and does not compute a return from them.
-- What a supply is classified as, and what rate that classification carries, is
-- decided in the catalogue by the person who knows the goods; accounting and
-- billing consume it. What inventory owes the rest of the system is that a
-- posted document keeps saying what it said: a reclassification next quarter
-- must not restate a purchase order, a receipt, or a sale that has already
-- happened. Hence a snapshot on every line rather than a join back to the SKU.
--
-- Every column here is nullable and every table change is additive, so nothing
-- existing moves. "Not recorded" and "recorded as nil" are different answers and
-- the schema keeps them apart: a default of 0% would have laundered every
-- unclassified SKU in the estate into "nil rated".
SET lock_timeout = '5s';
--> statement-breakpoint

-- Treatment is not derivable from the rate. TAXABLE at 0% and NIL_RATED look
-- identical on a line and are different rows in a GSTR-1 summary; EXEMPT and
-- NON_GST differ again in whether input credit has to be reversed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inv_tax_treatment') THEN
    CREATE TYPE "inv_tax_treatment" AS ENUM ('TAXABLE', 'EXEMPT', 'NIL_RATED', 'ZERO_RATED', 'NON_GST');
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inv_gst_mode') THEN
    CREATE TYPE "inv_gst_mode" AS ENUM ('REGULAR', 'COMPOSITION');
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "hsn_code" text;
--> statement-breakpoint
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "tax_treatment" "inv_tax_treatment";
--> statement-breakpoint
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "gst_rate" numeric(5, 2);
--> statement-breakpoint

-- A treatment that is not TAXABLE cannot carry a rate. NOT VALID first so the
-- catalogue is not scanned under ACCESS EXCLUSIVE, then validated separately.
ALTER TABLE "inv_products"
  ADD CONSTRAINT "chk_inv_products_tax_treatment_rate"
  CHECK ("tax_treatment" IS NULL OR "tax_treatment" = 'TAXABLE' OR "gst_rate" IS NULL OR "gst_rate" = 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_products" VALIDATE CONSTRAINT "chk_inv_products_tax_treatment_rate";
--> statement-breakpoint

-- The HSN summary of a return groups the catalogue by code, so the code leads
-- after the tenant. Partial: most rows carry no code until the gst pack is on.
CREATE INDEX IF NOT EXISTS "idx_inv_products_org_hsn"
  ON "inv_products" ("org_id", "hsn_code") WHERE "hsn_code" IS NOT NULL;
--> statement-breakpoint

-- The registration mode, beside the packs it belongs with. Defaulted rather than
-- nullable because every organisation has one, and REGULAR is the answer for all
-- but a handful.
ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "gst_mode" "inv_gst_mode" DEFAULT 'REGULAR' NOT NULL;
--> statement-breakpoint

ALTER TABLE "inv_po_lines" ADD COLUMN IF NOT EXISTS "hsn_code" text;
--> statement-breakpoint
ALTER TABLE "inv_po_lines" ADD COLUMN IF NOT EXISTS "tax_treatment" "inv_tax_treatment";
--> statement-breakpoint
ALTER TABLE "inv_po_lines" ADD COLUMN IF NOT EXISTS "gst_mode" "inv_gst_mode";
--> statement-breakpoint
ALTER TABLE "inv_po_lines" ADD COLUMN IF NOT EXISTS "tax_amount" numeric(18, 4);
--> statement-breakpoint

ALTER TABLE "inv_so_lines" ADD COLUMN IF NOT EXISTS "hsn_code" text;
--> statement-breakpoint
ALTER TABLE "inv_so_lines" ADD COLUMN IF NOT EXISTS "tax_treatment" "inv_tax_treatment";
--> statement-breakpoint
ALTER TABLE "inv_so_lines" ADD COLUMN IF NOT EXISTS "gst_mode" "inv_gst_mode";
--> statement-breakpoint
ALTER TABLE "inv_so_lines" ADD COLUMN IF NOT EXISTS "tax_amount" numeric(18, 4);
--> statement-breakpoint

-- A composition dealer may not collect tax from a customer, so an outward line
-- that snapshots COMPOSITION and still shows a rate is an invoice that could not
-- lawfully have been raised. Sales only — a composition dealer still pays tax on
-- what it buys.
ALTER TABLE "inv_so_lines"
  ADD CONSTRAINT "chk_inv_so_lines_composition_no_outward_tax"
  CHECK ("gst_mode" IS DISTINCT FROM 'COMPOSITION' OR ("tax_rate" = 0 AND COALESCE("tax_amount", 0) = 0)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_so_lines" VALIDATE CONSTRAINT "chk_inv_so_lines_composition_no_outward_tax";
--> statement-breakpoint

-- A receipt takes the inputs again rather than reading them off the order:
-- months can pass between ordering and receiving, and a reclassification in
-- between belongs to the receipt, which is the document credit is claimed
-- against. No amount column — a GRN line prices nothing.
ALTER TABLE "inv_grn_lines" ADD COLUMN IF NOT EXISTS "hsn_code" text;
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" ADD COLUMN IF NOT EXISTS "tax_treatment" "inv_tax_treatment";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" ADD COLUMN IF NOT EXISTS "gst_mode" "inv_gst_mode";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" ADD COLUMN IF NOT EXISTS "tax_rate" numeric(5, 2);
