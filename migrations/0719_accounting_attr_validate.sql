SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE accounting_periods VALIDATE CONSTRAINT fk_accounting_periods_closed_by_membership;
--> statement-breakpoint
ALTER TABLE accounting_periods VALIDATE CONSTRAINT fk_accounting_periods_locked_by_membership;
--> statement-breakpoint
ALTER TABLE fin_bank_imports VALIDATE CONSTRAINT fk_fin_bank_imports_created_by_membership;
--> statement-breakpoint
ALTER TABLE fin_reconciliation_matches VALIDATE CONSTRAINT fk_fin_recon_matches_confirmed_by_membership;
--> statement-breakpoint
ALTER TABLE fin_bank_transfers VALIDATE CONSTRAINT fk_fin_bank_transfers_created_by_membership;
--> statement-breakpoint
ALTER TABLE fin_cash_flow_scenarios VALIDATE CONSTRAINT fk_fin_cash_flow_scenarios_created_by_membership;
--> statement-breakpoint
ALTER TABLE fin_budgets VALIDATE CONSTRAINT fk_fin_budgets_created_by_membership;
--> statement-breakpoint
ALTER TABLE fin_budgets VALIDATE CONSTRAINT fk_fin_budgets_approved_by_membership;
