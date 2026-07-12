ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "ledger_account_id" integer REFERENCES "ledger_accounts"("id");
