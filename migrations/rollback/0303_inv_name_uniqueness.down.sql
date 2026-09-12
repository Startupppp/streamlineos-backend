-- 0303.down — Drop per-org name uniqueness on categories and channels.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_categories_org_name";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_channels_org_name";
