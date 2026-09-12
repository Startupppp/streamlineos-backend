-- 0552.down — Drop the GL reconciliation covering indexes.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_txn_org_effective_date";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_val_consumptions_org_layer_created";
