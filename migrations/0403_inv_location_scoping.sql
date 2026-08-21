-- 0403: Warehouse-level access scoping (D-07). RBAC has no location dimension,
-- so a warehouse operator currently transacts across every warehouse in the org.
-- Resolved once per request into an id list and applied as a plain IN predicate —
-- deliberately not the correlated-subquery shape that `team` DataScope uses.

SET statement_timeout = 0;
SET lock_timeout = '5s';

CREATE TABLE "inv_user_warehouses" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL,
  "warehouse_id" integer NOT NULL,
  "granted_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_user_warehouses_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "fk_inv_user_warehouses_org"
    FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_inv_user_warehouses_user"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_inv_user_warehouses_granted_by"
    FOREIGN KEY ("granted_by") REFERENCES "users" ("id"),
  CONSTRAINT "fk_inv_user_warehouses_org_warehouse"
    FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "inv_warehouses" ("org_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_inv_user_warehouses_key"
  ON "inv_user_warehouses" ("org_id", "user_id", "warehouse_id");
--> statement-breakpoint
CREATE INDEX "idx_inv_user_warehouses_org_user"
  ON "inv_user_warehouses" ("org_id", "user_id");
