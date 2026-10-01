SET lock_timeout = '5s';
--> statement-breakpoint

DROP TABLE IF EXISTS "ai_credit_legacy_reconciliations";
DROP INDEX IF EXISTS "uq_ai_credit_txns_refund_ref";
--> statement-breakpoint
