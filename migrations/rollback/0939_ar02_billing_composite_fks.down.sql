-- 0939_ar02_billing_composite_fks DOWN — drops every constraint and index the up migration added.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE subscription_payments DROP CONSTRAINT IF EXISTS "fk_sub_payments_org_sub";
--> statement-breakpoint
ALTER TABLE billing_proration_lines DROP CONSTRAINT IF EXISTS "fk_billing_proration_org_sub";
--> statement-breakpoint
ALTER TABLE subscription_items DROP CONSTRAINT IF EXISTS "fk_sub_items_org_sub";
--> statement-breakpoint
ALTER TABLE billing_credit_note_lines DROP CONSTRAINT IF EXISTS "fk_billing_credit_note_lines_org_note";
--> statement-breakpoint
ALTER TABLE billing_credit_notes DROP CONSTRAINT IF EXISTS "fk_billing_credit_notes_org_snap";
--> statement-breakpoint
ALTER TABLE billing_invoice_line_snapshots DROP CONSTRAINT IF EXISTS "fk_billing_inv_lines_org_rollup";
--> statement-breakpoint
ALTER TABLE billing_invoice_line_snapshots DROP CONSTRAINT IF EXISTS "fk_billing_inv_lines_org_proration";
--> statement-breakpoint
ALTER TABLE billing_invoice_line_snapshots DROP CONSTRAINT IF EXISTS "fk_billing_inv_lines_org_snap";
--> statement-breakpoint
ALTER TABLE billing_invoice_snapshots DROP CONSTRAINT IF EXISTS "fk_billing_inv_snap_org_sub";
