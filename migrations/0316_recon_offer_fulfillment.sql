-- wave-6-offer-fulfillment.sql  (T6.4)
-- Integration-owned CRM Offer ↔ Inventory SKU fulfillment mapping.
-- No FK into crm_products or inv_product_variants (module decoupling); only the
-- tenant org_id FK is DB-enforced. Idempotent + transactional.

BEGIN;

CREATE TABLE IF NOT EXISTS offer_fulfillment_components (
  offer_fulfillment_component_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  crm_offer_id      integer     NOT NULL,
  crm_offer_org_id  text        NOT NULL,
  inv_sku_id        integer     NOT NULL,
  inv_sku_org_id    text        NOT NULL,
  quantity_per_unit numeric(10,4) NOT NULL DEFAULT '1',
  uom               text,
  status            text        NOT NULL DEFAULT 'active',
  effective_from    timestamp,
  effective_to      timestamp,
  notes             text,
  created_by        text        NOT NULL REFERENCES users(id),
  created_at        timestamp   NOT NULL DEFAULT now(),
  updated_at        timestamp   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_offer_fulfillment_components_org_offer_sku
  ON offer_fulfillment_components (org_id, crm_offer_id, inv_sku_id);

CREATE INDEX IF NOT EXISTS idx_offer_fulfillment_components_offer
  ON offer_fulfillment_components (org_id, crm_offer_id);

CREATE INDEX IF NOT EXISTS idx_offer_fulfillment_components_sku
  ON offer_fulfillment_components (org_id, inv_sku_id);

COMMIT;
