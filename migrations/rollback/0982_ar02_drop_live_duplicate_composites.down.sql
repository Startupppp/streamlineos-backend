-- 0982 DOWN — intentionally a no-op. Each dropped constraint duplicated another constraint over the same (tenant, child) columns to the same parent, which still exists, so enforcement is unchanged and recreating the duplicate would undo the repair.

SET lock_timeout = '5s';
--> statement-breakpoint
SELECT 1;

-- invitations.fk_invitations_org_accepted_membership was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- invitations.fk_invitations_org_inviter_membership was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- invitations.fk_invitations_revoked_by_membership_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- ticket_comments.fk_ticket_comments_parent_comment_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- build.tickets.fk_tickets_epic_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- build.work_item_relations.fk_work_item_relations_related_work_item_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- build.pages.fk_pages_parent_page_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- build.okr_goals.fk_okr_goals_parent_goal_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- goals.fk_goals_parent_goal_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- documents.fk_documents_parent_document_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- hr_case_notes.fk_s01_hr_a36b1c9397e2b19b was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- hr_insurance_claims.fk_s01_hr_c32c5f12eb6efc88 was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- subscription_payments.fk_subscription_payments_subscription_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- journal_entries.fk_journal_entries_reversed_entry_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- ledger_accounts.fk_ledger_accounts_parent_account_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- billing_invoice_line_snapshots.fk_billing_invoice_line_snapshots_proration_line_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- billing_invoice_line_snapshots.fk_billing_invoice_line_snapshots_usage_rollup_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- billing_invoice_line_snapshots.fk_billing_invoice_line_snapshots_snapshot_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- billing_credit_notes.fk_billing_credit_notes_original_snapshot_id_org was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
-- billing_credit_note_lines.fk_billing_credit_note_lines_org_note was a duplicate of the constraint kept for the same columns; recreating it would reintroduce the duplicate.
