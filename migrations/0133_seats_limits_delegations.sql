CREATE TABLE "user_seats" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "module_key" text NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "assigned_at" timestamp DEFAULT now() NOT NULL,
  "assigned_by" text REFERENCES "users"("id")
);

CREATE UNIQUE INDEX "uniq_user_seats_org_user_module" ON "user_seats"("org_id", "user_id", "module_key");
CREATE INDEX "idx_user_seats_org_module" ON "user_seats"("org_id", "module_key");
CREATE INDEX "idx_user_seats_user" ON "user_seats"("user_id");

CREATE TABLE "org_limits" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "limit_key" text NOT NULL,
  "limit_value" integer NOT NULL,
  "used_value" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "uniq_org_limits_org_key" ON "org_limits"("org_id", "limit_key");
CREATE INDEX "idx_org_limits_org" ON "org_limits"("org_id");

CREATE TABLE "user_delegations" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "delegator_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "delegatee_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "permissions" text[] DEFAULT '{}' NOT NULL,
  "starts_at" timestamp DEFAULT now() NOT NULL,
  "ends_at" timestamp NOT NULL,
  "reason" text,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "revoked_at" timestamp,
  "revoked_by" text REFERENCES "users"("id")
);

CREATE INDEX "idx_user_delegations_delegatee_status" ON "user_delegations"("delegatee_id", "status");
CREATE INDEX "idx_user_delegations_org_ends" ON "user_delegations"("org_id", "ends_at");
