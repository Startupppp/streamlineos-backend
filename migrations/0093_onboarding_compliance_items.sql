ALTER TABLE "onboarding_template_steps" ADD COLUMN IF NOT EXISTS "is_compliance_item" boolean NOT NULL DEFAULT false;
