CREATE TABLE IF NOT EXISTS "crm_lead_touchpoints" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "lead_id" integer NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "campaign_id" integer REFERENCES "crm_campaigns"("id") ON DELETE SET NULL,
  "source_key" text NOT NULL,
  "medium" text,
  "utm_data" jsonb,
  "touch_type" text NOT NULL,
  "occurred_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_crm_lead_touchpoints_org_lead_occurred"
  ON "crm_lead_touchpoints"("org_id", "lead_id", "occurred_at");

CREATE INDEX IF NOT EXISTS "idx_crm_lead_touchpoints_org_occurred"
  ON "crm_lead_touchpoints"("org_id", "occurred_at");

ALTER TABLE "crm_campaigns" ADD COLUMN IF NOT EXISTS "utm_campaign_key" text;

INSERT INTO "crm_lead_touchpoints" (org_id, lead_id, source_key, medium, utm_data, touch_type, occurred_at)
SELECT
  org_id,
  id,
  COALESCE(source, 'direct') AS source_key,
  utm_medium AS medium,
  CASE
    WHEN utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL THEN
      jsonb_strip_nulls(jsonb_build_object(
        'utm_source', utm_source,
        'utm_medium', utm_medium,
        'utm_campaign', utm_campaign,
        'utm_content', utm_content,
        'utm_term', utm_term
      ))
    ELSE NULL
  END AS utm_data,
  'first_touch' AS touch_type,
  created_at AS occurred_at
FROM "leads"
WHERE deleted_at IS NULL
ON CONFLICT DO NOTHING;
