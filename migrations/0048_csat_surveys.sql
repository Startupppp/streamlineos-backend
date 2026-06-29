CREATE TABLE IF NOT EXISTS "csat_surveys" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "client_id" integer,
  "title" text NOT NULL,
  "question" text NOT NULL DEFAULT 'How satisfied are you with our service?',
  "scale_max" integer NOT NULL DEFAULT 5,
  "status" text NOT NULL DEFAULT 'draft',
  "public_token" text NOT NULL,
  "sent_at" timestamp,
  "closed_at" timestamp,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "csat_surveys_org_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id"),
  CONSTRAINT "csat_surveys_client_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade,
  CONSTRAINT "csat_surveys_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")
);
CREATE INDEX IF NOT EXISTS "idx_csat_surveys_org" ON "csat_surveys" ("org_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_csat_surveys_token" ON "csat_surveys" ("public_token");

CREATE TABLE IF NOT EXISTS "csat_responses" (
  "id" serial PRIMARY KEY NOT NULL,
  "survey_id" integer NOT NULL,
  "org_id" text NOT NULL,
  "rating" integer NOT NULL,
  "comment" text,
  "respondent_name" text,
  "respondent_email" text,
  "submitted_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "csat_responses_survey_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."csat_surveys"("id") ON DELETE cascade,
  CONSTRAINT "csat_responses_org_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
);
CREATE INDEX IF NOT EXISTS "idx_csat_responses_survey" ON "csat_responses" ("survey_id");
