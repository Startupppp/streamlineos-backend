ALTER TABLE "users" DROP COLUMN IF EXISTS "password";
ALTER TABLE "users" DROP COLUMN IF EXISTS "is_password_change_required";
ALTER TABLE "users" DROP COLUMN IF EXISTS "password_changed_at";
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "password_expiry_days";
DROP TABLE IF EXISTS "password_reset_tokens";
DROP TABLE IF EXISTS "password_history";
