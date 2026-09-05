SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE inv_quality_holds ADD COLUMN IF NOT EXISTS handling_unit_id INTEGER;
--> statement-breakpoint

ALTER TABLE inv_quality_holds ADD COLUMN IF NOT EXISTS ownership inv_ownership DEFAULT 'OWNED' NOT NULL;
--> statement-breakpoint

ALTER TABLE inv_quality_holds DROP CONSTRAINT IF EXISTS fk_inv_quality_holds_handling_unit;
--> statement-breakpoint
ALTER TABLE inv_quality_holds DROP CONSTRAINT IF EXISTS fk_inv_quality_holds_handling_unit_org;
--> statement-breakpoint

ALTER TABLE inv_quality_holds ADD CONSTRAINT fk_inv_quality_holds_handling_unit_org
  FOREIGN KEY (org_id, handling_unit_id)
  REFERENCES inv_handling_units(org_id, id)
  NOT VALID;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_inv_qh_org_hu
  ON inv_quality_holds(org_id, handling_unit_id)
  WHERE handling_unit_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_inv_qh_org_ownership
  ON inv_quality_holds(org_id, ownership, product_variant_id)
  WHERE ownership <> 'OWNED';
--> statement-breakpoint

ALTER TABLE inv_quality_holds VALIDATE CONSTRAINT fk_inv_quality_holds_handling_unit_org;
