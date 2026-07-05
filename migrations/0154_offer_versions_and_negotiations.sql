-- Offer versioning + negotiation timeline (PRD 24)

CREATE TABLE IF NOT EXISTS "offer_versions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "offer_id" integer NOT NULL REFERENCES "candidate_offers"("id") ON DELETE CASCADE,
  "version_number" integer NOT NULL,
  "offered_salary" decimal(15, 2),
  "offered_designation" text,
  "joining_date" date,
  "valid_until" date,
  "notes" text,
  "change_reason" text,
  "changed_by" text REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_offer_versions_offer" ON "offer_versions" ("offer_id");

CREATE TABLE IF NOT EXISTS "offer_negotiations" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "offer_id" integer NOT NULL REFERENCES "candidate_offers"("id") ON DELETE CASCADE,
  "direction" text NOT NULL,
  "proposed_salary" decimal(15, 2),
  "proposed_joining_date" date,
  "message" text,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_offer_negotiations_offer" ON "offer_negotiations" ("offer_id");
