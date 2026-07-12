ALTER TABLE "accounting_settings" ADD COLUMN IF NOT EXISTS "payment_terms" jsonb NOT NULL DEFAULT '[]';
