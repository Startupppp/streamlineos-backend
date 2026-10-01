SET lock_timeout = '5s';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_ai_credit_txns_refund_ref"
  ON "ai_credit_transactions" ("org_id", "reference_id")
  WHERE "type" = 'REFUND'
    AND "reference_id" IS NOT NULL
    AND "metadata"->>'source' = 'credit-ledger-adjustment';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ai_credit_legacy_reconciliations" (
  "org_id" TEXT PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
  "legacy_balance" INTEGER NOT NULL,
  "canonical_balance_milli" INTEGER,
  "discrepancy_milli" INTEGER,
  "status" VARCHAR(24) NOT NULL,
  "captured_at" TIMESTAMP NOT NULL DEFAULT now(),
  "resolved_at" TIMESTAMP,
  "resolution" JSONB,
  CONSTRAINT "ck_ai_credit_legacy_reconciliation_status"
    CHECK ("status" IN ('MATCHED', 'QUARANTINED', 'LEGACY_ONLY', 'RESOLVED'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_ai_credit_legacy_reconciliation_status"
  ON "ai_credit_legacy_reconciliations" ("status", "captured_at");
--> statement-breakpoint

INSERT INTO "ai_credit_legacy_reconciliations" (
  "org_id",
  "legacy_balance",
  "canonical_balance_milli",
  "discrepancy_milli",
  "status"
)
SELECT
  legacy."org_id",
  legacy."balance",
  canonical."balance",
  CASE WHEN canonical."org_id" IS NULL THEN NULL ELSE canonical."balance" - (legacy."balance" * 1000) END,
  CASE
    WHEN canonical."org_id" IS NULL THEN 'LEGACY_ONLY'
    WHEN canonical."balance" = legacy."balance" * 1000 THEN 'MATCHED'
    ELSE 'QUARANTINED'
  END
FROM "tenant_ai_credits" legacy
LEFT JOIN "org_ai_credits" canonical ON canonical."org_id" = legacy."org_id"
ON CONFLICT ("org_id") DO NOTHING;
--> statement-breakpoint

ALTER TABLE "ai_credit_legacy_reconciliations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ai_credit_legacy_reconciliations";
CREATE POLICY tenant_isolation ON "ai_credit_legacy_reconciliations"
  FOR ALL USING ("org_id" = app.current_org_id()) WITH CHECK ("org_id" = app.current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_credit_legacy_reconciliations" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uq_ai_credit_txns_refund_ref'
  ), '1704 post-check: idempotent refund reference index is absent';
  ASSERT NOT EXISTS (
    SELECT 1 FROM "ai_credit_legacy_reconciliations"
    WHERE "status" NOT IN ('MATCHED', 'QUARANTINED', 'LEGACY_ONLY', 'RESOLVED')
  ), '1704 post-check: reconciliation contains an unknown status';
END $$;
--> statement-breakpoint
