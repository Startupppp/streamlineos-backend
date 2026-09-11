-- 0993 DOWN — restores the global UNIQUE(code) on coupons and removes the two
-- tenant-scoped partial uniques.
--
-- The forward migration's collision pre-pass is not reversible: a code it
-- suffixed with -DUP<id> stays suffixed, because the original value is exactly
-- what the restored global unique forbids a second row from holding. Re-adding
-- the constraint therefore succeeds on any database the forward migration ran
-- against; it aborts only if new colliding rows were written while the
-- tenant-scoped rules were in force, which is the honest outcome — the operator
-- has to decide which tenant keeps the code.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS uniq_coupons_org_code;
--> statement-breakpoint

DROP INDEX IF EXISTS uniq_coupons_platform_code;
--> statement-breakpoint

ALTER TABLE coupons ADD CONSTRAINT coupons_code_unique UNIQUE (code);
