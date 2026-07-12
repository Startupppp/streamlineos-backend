ALTER TABLE "fin_reimbursement_batches" ADD COLUMN IF NOT EXISTS "bank_account_id" integer REFERENCES "fin_bank_accounts"("id");
