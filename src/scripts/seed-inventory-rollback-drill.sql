-- Production-sized inventory dataset for the migration rollback rehearsal.
--
-- The drill's round trip is only as strong as the data it carries across.
-- Over seven rows a green means "nothing broke on an empty schema"; the PRD
-- (§12.10) asks the rehearsal to run at a volume a real tenant would have.
-- Deterministic natural keys, so re-running tops the dataset up instead of
-- doubling it.
--
-- Sized so that inv_product_variants lands ABOVE the drill's 20k digest cap and
-- inv_stock_levels below it: the drill then reports one table it can only count,
-- which is the honest shape of a capped digest rather than a hidden one.
\set ON_ERROR_STOP on

BEGIN;

-- Bootstrap a tenant when the database has none.
--
-- This used to read org_id/created_by off an existing inv_products row, which
-- meant that on a COLD-BUILT database -- no organisations, no users, no products
-- -- every INSERT below matched zero scope rows and the script reported success
-- having seeded nothing. The drill's own row floor caught it (0 rows, EXIT=2),
-- but a seed script that silently seeds nothing is a defect on its own.
--
-- organizations.owner_membership_id and organization_members.org_id reference
-- each other, so the pair only inserts with constraints deferred inside one
-- transaction.
SET CONSTRAINTS ALL DEFERRED;

INSERT INTO users (id, email)
SELECT 'drill-seed-user', 'drill-seed@drill.invalid'
WHERE NOT EXISTS (SELECT 1 FROM inv_products)
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = 'drill-seed-user');

INSERT INTO organizations (id, name, slug, owner_membership_id)
SELECT 'drill-seed-org', 'Rollback Drill Org', 'rollback-drill-org', 0
WHERE NOT EXISTS (SELECT 1 FROM inv_products)
  AND NOT EXISTS (SELECT 1 FROM organizations WHERE id = 'drill-seed-org');

INSERT INTO organization_members (org_id, user_id)
SELECT 'drill-seed-org', 'drill-seed-user'
WHERE EXISTS (SELECT 1 FROM organizations WHERE id = 'drill-seed-org')
  AND NOT EXISTS (
    SELECT 1 FROM organization_members WHERE org_id = 'drill-seed-org' AND user_id = 'drill-seed-user'
  );

UPDATE organizations o
   SET owner_membership_id = m.id
  FROM organization_members m
 WHERE o.id = 'drill-seed-org' AND m.org_id = o.id AND o.owner_membership_id = 0;

-- One product, so the scope query below has something to read.
INSERT INTO inv_products (org_id, name, sku, created_by)
SELECT 'drill-seed-org', 'Drill Seed Anchor', 'DRILL-ANCHOR-000000', 'drill-seed-user'
WHERE EXISTS (SELECT 1 FROM organizations WHERE id = 'drill-seed-org')
  AND NOT EXISTS (SELECT 1 FROM inv_products WHERE sku = 'DRILL-ANCHOR-000000');

CREATE TEMP TABLE drill_scope ON COMMIT DROP AS
SELECT org_id, created_by FROM inv_products ORDER BY id LIMIT 1;

-- Refuse rather than seed nothing. A silent no-op here produces a drill run that
-- reports a clean round trip over an empty schema.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM drill_scope) THEN
    RAISE EXCEPTION 'seed-inventory-rollback-drill: no tenant to seed under, and the bootstrap above did not create one. Refusing to seed nothing.';
  END IF;
END $$;

INSERT INTO inv_uom (org_id, name, abbreviation)
SELECT s.org_id, 'Drill UOM ' || n, 'du' || n
FROM drill_scope s, generate_series(1, 8) AS n
ON CONFLICT (org_id, name) DO NOTHING;

INSERT INTO inv_categories (org_id, name)
SELECT s.org_id, 'Drill Category ' || n
FROM drill_scope s, generate_series(1, 60) AS n
ON CONFLICT (org_id, name) DO NOTHING;

INSERT INTO inv_warehouses (org_id, name, code, created_by)
SELECT s.org_id, 'Drill Warehouse ' || n, 'DWH' || lpad(n::text, 3, '0'), s.created_by
FROM drill_scope s, generate_series(1, 12) AS n
ON CONFLICT (org_id, code) DO NOTHING;

INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
SELECT w.org_id, w.id, 'Bin ' || n, 'B' || lpad(n::text, 4, '0'),
       (ARRAY['BIN','RACK','AISLE','ZONE']::inv_location_type[])[1 + (n % 4)]
FROM inv_warehouses w, generate_series(1, 60) AS n
WHERE w.code LIKE 'DWH%'
ON CONFLICT (warehouse_id, code) DO NOTHING;

INSERT INTO inv_products (org_id, name, sku, created_by, category_id, uom_id)
SELECT s.org_id, 'Drill Product ' || n, 'DRILL-P-' || lpad(n::text, 6, '0'), s.created_by,
       (SELECT id FROM inv_categories c WHERE c.org_id = s.org_id ORDER BY c.id OFFSET (n % 60) LIMIT 1),
       (SELECT id FROM inv_uom u WHERE u.org_id = s.org_id ORDER BY u.id OFFSET (n % 8) LIMIT 1)
FROM drill_scope s, generate_series(1, 9000) AS n
ON CONFLICT (org_id, sku) WHERE deleted_at IS NULL DO NOTHING;

INSERT INTO inv_product_variants (org_id, product_id, name, sku)
SELECT p.org_id, p.id, 'Variant ' || n, p.sku || '-V' || n
FROM inv_products p, generate_series(1, 3) AS n
WHERE p.sku LIKE 'DRILL-P-%'
ON CONFLICT (org_id, sku) WHERE deleted_at IS NULL DO NOTHING;

INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_hand, committed, average_cost)
SELECT v.org_id, v.id, l.id,
       ((v.id % 500) + 1)::numeric, ((v.id % 37))::numeric, ((v.id % 900) + 10)::numeric
FROM (SELECT id, org_id, row_number() OVER (ORDER BY id) AS rn
      FROM inv_product_variants WHERE sku LIKE 'DRILL-P-%' ORDER BY id LIMIT 18000) v
JOIN (SELECT id, row_number() OVER (ORDER BY id) AS rn
      FROM inv_locations WHERE code LIKE 'B%') l
  ON l.rn = 1 + ((v.rn - 1) % (SELECT count(*) FROM inv_locations WHERE code LIKE 'B%'))
ON CONFLICT DO NOTHING;

INSERT INTO inv_quality_holds (org_id, product_variant_id, location_id, quantity, reason, status, created_by)
SELECT sl.org_id, sl.product_variant_id, sl.location_id,
       ((sl.id % 40) + 1)::numeric, 'Drill hold ' || sl.id,
       (ARRAY['ACTIVE','RELEASED']::inv_quality_hold_status[])[1 + (sl.id % 2)], s.created_by
FROM drill_scope s, (SELECT id, org_id, product_variant_id, location_id
                     FROM inv_stock_levels ORDER BY id LIMIT 2500) sl
WHERE NOT EXISTS (
  SELECT 1 FROM inv_quality_holds q WHERE q.reason = 'Drill hold ' || sl.id
);

INSERT INTO inv_projects (org_id, code, name, status, created_by)
SELECT s.org_id, 'DRILL-PRJ-' || lpad(n::text, 4, '0'), 'Drill Project ' || n,
       (ARRAY['PLANNING','ACTIVE','ON_HOLD','COMPLETED','CANCELLED']::inv_project_status[])[1 + (n % 5)],
       s.created_by
FROM drill_scope s, generate_series(1, 400) AS n
ON CONFLICT (org_id, code) WHERE deleted_at IS NULL DO NOTHING;

COMMIT;

SELECT 'inv_products' AS t, count(*) FROM inv_products
UNION ALL SELECT 'inv_product_variants', count(*) FROM inv_product_variants
UNION ALL SELECT 'inv_stock_levels', count(*) FROM inv_stock_levels
UNION ALL SELECT 'inv_quality_holds', count(*) FROM inv_quality_holds
UNION ALL SELECT 'inv_projects', count(*) FROM inv_projects
UNION ALL SELECT 'inv_locations', count(*) FROM inv_locations;
