SET lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
  plaintext_rows bigint;
BEGIN
  SELECT count(*) INTO plaintext_rows
  FROM hr_employee_sensitive_fields
  WHERE bank_details IS NOT NULL;

  IF plaintext_rows > 0 THEN
    RAISE EXCEPTION
      'hr_employee_sensitive_fields.bank_details holds % unencrypted row(s); re-seal them through sealBankDetails before converting the column',
      plaintext_rows;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "hr_employee_sensitive_fields"
  ALTER COLUMN "bank_details" SET DATA TYPE text USING NULL;
--> statement-breakpoint
ALTER TABLE "hr_employee_sensitive_fields"
  ADD COLUMN IF NOT EXISTS "encryption_key_ref" text;
--> statement-breakpoint
ALTER TABLE "hr_audit_logs"
  ADD COLUMN IF NOT EXISTS "actor_membership_id" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_audit_logs_org_actor_membership"
  ON "hr_audit_logs" USING btree ("org_id", "actor_membership_id");
