-- 0407: Stock policy gains the grain it needs. Negative stock was one org-wide
-- boolean; approval thresholds were quantity-only, so a one-unit write-off of a
-- high-value item never required approval. Reason codes move from a fixed enum to
-- a per-tenant table because reason codes are what make shrinkage analysis
-- possible. The inv_adj_reason enum is left in place and seeded here.

SET statement_timeout = 0;
SET lock_timeout = '5s';

CREATE TYPE "inv_reason_category" AS ENUM ('ADJUSTMENT', 'COUNT', 'SCRAP', 'RETURN', 'TRANSFER', 'OTHER');
--> statement-breakpoint

ALTER TABLE "inv_products" ADD COLUMN "allow_negative_stock" boolean;
--> statement-breakpoint

ALTER TABLE "inv_settings" ADD COLUMN "adjustment_approval_value_threshold" numeric(18, 4);
--> statement-breakpoint

CREATE TABLE "inv_reason_codes" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "code" text NOT NULL,
  "label" text NOT NULL,
  "category" "inv_reason_category" DEFAULT 'ADJUSTMENT' NOT NULL,
  "requires_approval" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_reason_codes_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "fk_inv_reason_codes_org"
    FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_inv_reason_codes_org_code" ON "inv_reason_codes" ("org_id", "code");
--> statement-breakpoint
CREATE INDEX "idx_inv_reason_codes_org_category" ON "inv_reason_codes" ("org_id", "category");
--> statement-breakpoint

INSERT INTO "inv_reason_codes" ("org_id", "code", "label", "category", "requires_approval")
SELECT o."id", v.code, v.label, v.category::"inv_reason_category", v.requires_approval
FROM "organizations" o
CROSS JOIN (VALUES
  ('PURCHASE', 'Purchase',        'ADJUSTMENT', false),
  ('SALE',     'Sale',            'ADJUSTMENT', false),
  ('RETURN',   'Return',          'RETURN',     false),
  ('DAMAGE',   'Damage',          'SCRAP',      true),
  ('EXPIRY',   'Expiry',          'SCRAP',      true),
  ('THEFT',    'Theft / Shrinkage','SCRAP',     true),
  ('RECOUNT',  'Count correction', 'COUNT',     true),
  ('OTHER',    'Other',            'OTHER',     true)
) AS v(code, label, category, requires_approval)
ON CONFLICT DO NOTHING;
