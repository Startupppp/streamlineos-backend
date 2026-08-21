-- 0404: Posting date is distinct from created_at. created_at is when the row was
-- written; posting_date is the business date the movement belongs to. Conflating
-- them is what makes a backdated entry invisible to a period-close check.

SET statement_timeout = 0;
SET lock_timeout = '5s';

ALTER TABLE "inv_stock_transactions" ADD COLUMN "posting_date" date;
--> statement-breakpoint

CREATE INDEX "idx_inv_txn_org_posting_date"
  ON "inv_stock_transactions" ("org_id", "posting_date");
