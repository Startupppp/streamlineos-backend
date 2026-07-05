-- PRD 13 (Candidate CRM, Talent Pools And Sourcing) — Milestone 5.
-- Fully greenfield: no talent pool concept existed anywhere prior to this.

BEGIN;

CREATE TABLE "talent_pools" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX "idx_talent_pools_org" ON "talent_pools" ("org_id");

CREATE TABLE "talent_pool_members" (
  "id" serial PRIMARY KEY,
  "pool_id" integer NOT NULL REFERENCES "talent_pools"("id") ON DELETE CASCADE,
  "candidate_id" integer NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "notes" text,
  "added_by" text REFERENCES "users"("id"),
  "added_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_talent_pool_members_pool_candidate" UNIQUE ("pool_id", "candidate_id")
);

CREATE INDEX "idx_talent_pool_members_pool" ON "talent_pool_members" ("pool_id");
CREATE INDEX "idx_talent_pool_members_candidate" ON "talent_pool_members" ("candidate_id");

COMMIT;
