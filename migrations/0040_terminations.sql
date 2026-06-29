-- ─── Termination Status Enum ───
CREATE TYPE termination_status AS ENUM ('DRAFT', 'PENDING_CEO', 'APPROVED', 'REJECTED', 'SENT', 'COMPLETED');

-- ─── Terminations Table ───
CREATE TABLE IF NOT EXISTS "terminations" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "reasons" text[] NOT NULL DEFAULT '{}',
  "detailed_explanation" text NOT NULL,
  "effective_date" date NOT NULL,
  "severance_amount" decimal,
  "notice_period_waived" boolean DEFAULT false,
  "termination_letter_url" text,
  "supporting_doc_urls" text[] DEFAULT '{}',
  "internal_notes" text,
  "status" termination_status DEFAULT 'DRAFT',
  "initiated_by" text REFERENCES "users"("id"),
  "ceo_reviewed_by" text REFERENCES "users"("id"),
  "ceo_reviewed_at" timestamp,
  "ceo_remarks" text,
  "email_sent_at" timestamp,
  "email_status" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX "idx_terminations_org" ON "terminations"("org_id");
CREATE INDEX "idx_terminations_user" ON "terminations"("user_id");
CREATE INDEX "idx_terminations_status" ON "terminations"("status");
