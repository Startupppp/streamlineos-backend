CREATE INDEX IF NOT EXISTS "idx_verification_tokens_expires" ON "verification_tokens" USING btree ("expires");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_password_reset_email_expires" ON "password_reset_tokens" USING btree ("email","expires_at");
