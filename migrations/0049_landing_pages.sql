CREATE TABLE IF NOT EXISTS "landing_pages" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "description" text,
  "is_active" boolean DEFAULT true,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "page_views" (
  "id" serial PRIMARY KEY,
  "page_id" integer REFERENCES "landing_pages"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL,
  "referrer" text,
  "country" text,
  "city" text,
  "device_type" text,
  "viewed_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "page_views_page_id_idx" ON "page_views"("page_id");
CREATE INDEX IF NOT EXISTS "page_views_org_id_idx" ON "page_views"("org_id");
CREATE INDEX IF NOT EXISTS "page_views_viewed_at_idx" ON "page_views"("viewed_at");
