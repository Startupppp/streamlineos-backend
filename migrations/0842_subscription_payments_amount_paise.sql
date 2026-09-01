SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE subscription_payments ADD COLUMN amount_paise integer;
--> statement-breakpoint

UPDATE subscription_payments SET amount_paise = ROUND(amount * 100)::integer WHERE amount IS NOT NULL;
--> statement-breakpoint

ALTER TABLE subscription_payments ADD CONSTRAINT chk_sp_amount_paise CHECK (amount_paise IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE subscription_payments VALIDATE CONSTRAINT chk_sp_amount_paise;
--> statement-breakpoint

ALTER TABLE subscription_payments ALTER COLUMN amount_paise SET NOT NULL;
--> statement-breakpoint

ALTER TABLE subscription_payments DROP CONSTRAINT chk_sp_amount_paise;
--> statement-breakpoint

ALTER TABLE subscription_payments ALTER COLUMN amount DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE coupon_redemptions ADD COLUMN amount_paise integer;
--> statement-breakpoint

UPDATE coupon_redemptions SET amount_paise = ROUND(amount * 100)::integer WHERE amount IS NOT NULL;
--> statement-breakpoint

ALTER TABLE coupon_redemptions ADD CONSTRAINT chk_cr_amount_paise CHECK (amount_paise IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE coupon_redemptions VALIDATE CONSTRAINT chk_cr_amount_paise;
--> statement-breakpoint

ALTER TABLE coupon_redemptions ALTER COLUMN amount_paise SET NOT NULL;
--> statement-breakpoint

ALTER TABLE coupon_redemptions DROP CONSTRAINT chk_cr_amount_paise;
