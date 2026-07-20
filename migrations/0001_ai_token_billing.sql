UPDATE org_ai_credits SET balance=balance*1000, lifetime_granted=lifetime_granted*1000, lifetime_consumed=lifetime_consumed*1000, auto_top_up_threshold=auto_top_up_threshold*1000;
UPDATE ai_credit_reservations SET credits=credits*1000;
UPDATE ai_credit_transactions SET amount=amount*1000, balance_after=balance_after*1000;
ALTER TABLE ai_credit_transactions ADD COLUMN IF NOT EXISTS prompt_tokens int, ADD COLUMN IF NOT EXISTS completion_tokens int, ADD COLUMN IF NOT EXISTS total_tokens int, ADD COLUMN IF NOT EXISTS cost_usd numeric(12,6);
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS credits_milli int NOT NULL DEFAULT 0;
