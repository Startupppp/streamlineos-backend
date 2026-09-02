-- AR-02: Promote billing FK relations to composite (org_id, child_id) -> (org_id, id).
-- Each composite FK uses NOT VALID / VALIDATE to avoid ACCESS EXCLUSIVE during backfill.
-- SET NULL cases use PG15+ column-list syntax so only the child col is nulled (org_id is NOT NULL).
-- CRM and Inventory are excluded from this migration by design (see PRD-IN-SCOPE.md §4).

SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- billing_invoice_snapshots: subscription_id -> subscriptions
-- ---------------------------------------------------------------------------
ALTER TABLE billing_invoice_snapshots DROP CONSTRAINT IF EXISTS billing_invoice_snapshots_subscription_id_subscriptions_id_fk;

ALTER TABLE billing_invoice_snapshots
  ADD CONSTRAINT fk_billing_inv_snap_org_sub
  FOREIGN KEY (org_id, subscription_id)
  REFERENCES subscriptions (org_id, id)
  ON DELETE SET NULL (subscription_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE billing_invoice_snapshots VALIDATE CONSTRAINT fk_billing_inv_snap_org_sub;

-- ---------------------------------------------------------------------------
-- billing_invoice_line_snapshots: snapshot_id / proration_line_id / usage_rollup_id
-- ---------------------------------------------------------------------------
ALTER TABLE billing_invoice_line_snapshots DROP CONSTRAINT IF EXISTS billing_invoice_line_snapshots_snapshot_id_billing_invoice_snapshots_id_fk;
ALTER TABLE billing_invoice_line_snapshots DROP CONSTRAINT IF EXISTS billing_invoice_line_snapshots_proration_line_id_billing_proration_lines_id_fk;
ALTER TABLE billing_invoice_line_snapshots DROP CONSTRAINT IF EXISTS billing_invoice_line_snapshots_usage_rollup_id_billing_usage_rollups_id_fk;

ALTER TABLE billing_invoice_line_snapshots
  ADD CONSTRAINT fk_billing_inv_lines_org_snap
  FOREIGN KEY (org_id, snapshot_id)
  REFERENCES billing_invoice_snapshots (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE billing_invoice_line_snapshots VALIDATE CONSTRAINT fk_billing_inv_lines_org_snap;
--> statement-breakpoint

ALTER TABLE billing_invoice_line_snapshots
  ADD CONSTRAINT fk_billing_inv_lines_org_proration
  FOREIGN KEY (org_id, proration_line_id)
  REFERENCES billing_proration_lines (org_id, id)
  ON DELETE SET NULL (proration_line_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE billing_invoice_line_snapshots VALIDATE CONSTRAINT fk_billing_inv_lines_org_proration;
--> statement-breakpoint

ALTER TABLE billing_invoice_line_snapshots
  ADD CONSTRAINT fk_billing_inv_lines_org_rollup
  FOREIGN KEY (org_id, usage_rollup_id)
  REFERENCES billing_usage_rollups (org_id, id)
  ON DELETE SET NULL (usage_rollup_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE billing_invoice_line_snapshots VALIDATE CONSTRAINT fk_billing_inv_lines_org_rollup;

-- ---------------------------------------------------------------------------
-- billing_credit_notes: original_snapshot_id
-- ---------------------------------------------------------------------------
ALTER TABLE billing_credit_notes DROP CONSTRAINT IF EXISTS billing_credit_notes_original_snapshot_id_billing_invoice_snapshots_id_fk;

ALTER TABLE billing_credit_notes
  ADD CONSTRAINT fk_billing_credit_notes_org_snap
  FOREIGN KEY (org_id, original_snapshot_id)
  REFERENCES billing_invoice_snapshots (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE billing_credit_notes VALIDATE CONSTRAINT fk_billing_credit_notes_org_snap;

-- ---------------------------------------------------------------------------
-- billing_credit_note_lines: credit_note_id
-- ---------------------------------------------------------------------------
ALTER TABLE billing_credit_note_lines DROP CONSTRAINT IF EXISTS billing_credit_note_lines_credit_note_id_billing_credit_notes_id_fk;

ALTER TABLE billing_credit_note_lines
  ADD CONSTRAINT fk_billing_credit_note_lines_org_note
  FOREIGN KEY (org_id, credit_note_id)
  REFERENCES billing_credit_notes (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE billing_credit_note_lines VALIDATE CONSTRAINT fk_billing_credit_note_lines_org_note;

-- ---------------------------------------------------------------------------
-- subscription_items: subscription_id -> subscriptions
-- ---------------------------------------------------------------------------
ALTER TABLE subscription_items DROP CONSTRAINT IF EXISTS subscription_items_subscription_id_subscriptions_id_fk;

ALTER TABLE subscription_items
  ADD CONSTRAINT fk_sub_items_org_sub
  FOREIGN KEY (org_id, subscription_id)
  REFERENCES subscriptions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE subscription_items VALIDATE CONSTRAINT fk_sub_items_org_sub;

-- ---------------------------------------------------------------------------
-- billing_proration_lines: subscription_id -> subscriptions
-- ---------------------------------------------------------------------------
ALTER TABLE billing_proration_lines DROP CONSTRAINT IF EXISTS billing_proration_lines_subscription_id_subscriptions_id_fk;

ALTER TABLE billing_proration_lines
  ADD CONSTRAINT fk_billing_proration_org_sub
  FOREIGN KEY (org_id, subscription_id)
  REFERENCES subscriptions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE billing_proration_lines VALIDATE CONSTRAINT fk_billing_proration_org_sub;

-- ---------------------------------------------------------------------------
-- subscription_payments: subscription_id -> subscriptions
-- ---------------------------------------------------------------------------
ALTER TABLE subscription_payments DROP CONSTRAINT IF EXISTS subscription_payments_subscription_id_subscriptions_id_fk;

ALTER TABLE subscription_payments
  ADD CONSTRAINT fk_sub_payments_org_sub
  FOREIGN KEY (org_id, subscription_id)
  REFERENCES subscriptions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE subscription_payments VALIDATE CONSTRAINT fk_sub_payments_org_sub;
