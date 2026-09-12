-- Reverses 1102. Puts `sign_org_settings.public_forms_enabled` back with the
-- default 0000 gave it (true, NOT NULL). The value every row held before 1102
-- is not restored — nothing read it, so nothing depended on it — and the
-- feature the column once switched stays retired (0660b), so restoring the
-- column re-creates a switch that changes nothing.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "sign_org_settings" ADD COLUMN IF NOT EXISTS "public_forms_enabled" boolean DEFAULT true NOT NULL;
