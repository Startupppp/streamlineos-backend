CREATE TABLE IF NOT EXISTS "client_onboarding_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "is_default" boolean NOT NULL DEFAULT false,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "cot_org_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id"),
  CONSTRAINT "cot_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")
);
CREATE INDEX IF NOT EXISTS "idx_onboarding_templates_org" ON "client_onboarding_templates" ("org_id");

CREATE TABLE IF NOT EXISTS "client_onboarding_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "client_id" integer NOT NULL,
  "template_id" integer,
  "title" text NOT NULL,
  "description" text,
  "assigned_to" text,
  "due_date" date,
  "completed_at" timestamp,
  "completed_by" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "coi_org_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id"),
  CONSTRAINT "coi_client_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade,
  CONSTRAINT "coi_template_fk" FOREIGN KEY ("template_id") REFERENCES "public"."client_onboarding_templates"("id"),
  CONSTRAINT "coi_assigned_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id"),
  CONSTRAINT "coi_completed_by_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id")
);
CREATE INDEX IF NOT EXISTS "idx_onboarding_items_client" ON "client_onboarding_items" ("client_id");
CREATE INDEX IF NOT EXISTS "idx_onboarding_items_org" ON "client_onboarding_items" ("org_id");
