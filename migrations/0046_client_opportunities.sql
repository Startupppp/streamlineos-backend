CREATE TABLE IF NOT EXISTS "client_opportunities" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "client_id" integer NOT NULL,
  "title" text NOT NULL,
  "type" text NOT NULL DEFAULT 'upsell',
  "stage" text NOT NULL DEFAULT 'identified',
  "value" numeric(15,2),
  "notes" text,
  "expected_close_date" date,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "client_opportunities_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id"),
  CONSTRAINT "client_opportunities_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade,
  CONSTRAINT "client_opportunities_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")
);
CREATE INDEX IF NOT EXISTS "idx_client_opps_org" ON "client_opportunities" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_client_opps_client" ON "client_opportunities" ("client_id");
