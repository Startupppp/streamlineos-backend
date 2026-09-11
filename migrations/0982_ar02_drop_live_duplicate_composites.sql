-- AR-02: drop the remaining duplicate composite tenant foreign keys, keeping the member that carries the referential action; these existed only in the live catalog, so the scratch-derived 0977 could not see them.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS "fk_invitations_org_accepted_membership";
--> statement-breakpoint
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS "fk_invitations_org_inviter_membership";
--> statement-breakpoint
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS "fk_invitations_revoked_by_membership_id_org";
--> statement-breakpoint
ALTER TABLE ticket_comments DROP CONSTRAINT IF EXISTS "fk_ticket_comments_parent_comment_id_org";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS "fk_tickets_epic_id_org";
--> statement-breakpoint
ALTER TABLE build.work_item_relations DROP CONSTRAINT IF EXISTS "fk_work_item_relations_related_work_item_id_org";
--> statement-breakpoint
ALTER TABLE build.pages DROP CONSTRAINT IF EXISTS "fk_pages_parent_page_id_org";
--> statement-breakpoint
ALTER TABLE build.okr_goals DROP CONSTRAINT IF EXISTS "fk_okr_goals_parent_goal_id_org";
--> statement-breakpoint
ALTER TABLE goals DROP CONSTRAINT IF EXISTS "fk_goals_parent_goal_id_org";
--> statement-breakpoint
ALTER TABLE documents DROP CONSTRAINT IF EXISTS "fk_documents_parent_document_id_org";
--> statement-breakpoint
ALTER TABLE hr_case_notes DROP CONSTRAINT IF EXISTS "fk_s01_hr_a36b1c9397e2b19b";
--> statement-breakpoint
ALTER TABLE hr_insurance_claims DROP CONSTRAINT IF EXISTS "fk_s01_hr_c32c5f12eb6efc88";
--> statement-breakpoint
ALTER TABLE subscription_payments DROP CONSTRAINT IF EXISTS "fk_subscription_payments_subscription_id_org";
--> statement-breakpoint
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS "fk_journal_entries_reversed_entry_id_org";
--> statement-breakpoint
ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS "fk_ledger_accounts_parent_account_id_org";
--> statement-breakpoint
ALTER TABLE billing_invoice_line_snapshots DROP CONSTRAINT IF EXISTS "fk_billing_invoice_line_snapshots_proration_line_id_org";
--> statement-breakpoint
ALTER TABLE billing_invoice_line_snapshots DROP CONSTRAINT IF EXISTS "fk_billing_invoice_line_snapshots_usage_rollup_id_org";
--> statement-breakpoint
ALTER TABLE billing_invoice_line_snapshots DROP CONSTRAINT IF EXISTS "fk_billing_invoice_line_snapshots_snapshot_id_org";
--> statement-breakpoint
ALTER TABLE billing_credit_notes DROP CONSTRAINT IF EXISTS "fk_billing_credit_notes_original_snapshot_id_org";
--> statement-breakpoint
ALTER TABLE billing_credit_note_lines DROP CONSTRAINT IF EXISTS "fk_billing_credit_note_lines_org_note";
