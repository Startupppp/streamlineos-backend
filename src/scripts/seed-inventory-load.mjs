/**
 * INV-110 — a dataset the read-cost budgets can actually say something about.
 *
 * The budgets were never measured, and when they finally ran they reported
 * Seq Scan failures that were not real: the seed organisation held 87% of every
 * inventory table, so `org_id = $1` selected almost the whole relation and a
 * sequential scan was the *correct* plan. A tenant-filter benchmark is only
 * meaningful when the measured tenant is a minority of the table -- otherwise
 * the assertion tests nothing and fails for the wrong reason.
 *
 * So this spreads a bounded, tagged dataset across several existing
 * organisations and leaves the measured one a small share of the whole.
 *
 *   node src/scripts/seed-inventory-load.mjs                 seed
 *   node src/scripts/seed-inventory-load.mjs --purge         remove it again
 *   node src/scripts/seed-inventory-load.mjs --orgs=8 --variants=400 --movements=4000
 *
 * Everything it writes is tagged with PERF_TAG in the SKU and code columns, so
 * `--purge` removes exactly what this wrote and nothing a human created.
 */
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

const PRODUCTION_HOST_PATTERNS = ["amazonaws.com", "neon.tech", "neon-db.net", "supabase.co", ".render.com"];

function assertDisposableTarget(url) {
  if (!url) return { allowed: false, reason: "DATABASE_URL is not set" };
  const matched = PRODUCTION_HOST_PATTERNS.find((p) => url.includes(p));
  if (matched) return { allowed: false, reason: `DATABASE_URL names production host '${matched}'` };
  let host, dbName;
  try {
    const u = new URL(url.replace(/^postgresql:\/\//, "http://").replace(/^postgres:\/\//, "http://"));
    host = u.hostname;
    dbName = u.pathname.replace(/^\//, "");
  } catch {
    return { allowed: false, reason: "DATABASE_URL does not parse" };
  }
  if (host === "127.0.0.1" || host === "localhost") return { allowed: true, reason: `loopback target '${host}'` };
  if (/scratch|test/i.test(dbName)) return { allowed: true, reason: `scratch/test database '${dbName}'` };
  return { allowed: false, reason: `host '${host}' is not loopback and database '${dbName}' is not a scratch/test database` };
}

if (process.argv.includes("--self-test")) {
  const cases = [
    [assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/scratch_local"), true],
    [assertDisposableTarget("postgresql://u:p@localhost:5432/app"), true],
    [assertDisposableTarget("postgresql://u:p@prod.cluster.amazonaws.com/app"), false],
    [assertDisposableTarget("postgresql://u:p@prod.cluster.amazonaws.com/scratch_test"), false],
    [assertDisposableTarget(null), false],
  ];
  let failed = 0;
  for (const [verdict, expected] of cases)
    if (verdict.allowed !== expected) { console.error(`FAIL: expected allowed=${expected}, got ${verdict.reason}`); failed++; }
  if (failed) process.exit(1);
  console.log("PASS: seed-inventory-load target guard, 5 cases.");
  process.exit(0);
}

const PERF_TAG = "PERFLOAD";

function arg(name, fallback) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.slice(name.length + 3)) : fallback;
}

async function purge(sql) {
  // Children first: the movement ledger and projection reference the variant.
  const tables = [
    ["inv_stock_transactions", "product_variant_id IN (SELECT id FROM inv_product_variants WHERE sku LIKE $1)"],
    ["inv_stock_levels", "product_variant_id IN (SELECT id FROM inv_product_variants WHERE sku LIKE $1)"],
    ["inv_product_variants", "sku LIKE $1"],
    ["inv_products", "sku LIKE $1"],
    ["inv_purchase_orders", "po_number LIKE $1"],
    ["inv_vendors", "code LIKE $1"],
    ["inv_locations", "code LIKE $1"],
    ["inv_warehouses", "code LIKE $1"],
    ["inv_uom", "abbreviation LIKE $1"],
  ];
  for (const [table, predicate] of tables) {
    const result = await sql.unsafe(
      `DELETE FROM ${table} WHERE ${predicate}`,
      [`${PERF_TAG}%`],
    );
    console.log(`  purged ${result.count} from ${table}`);
  }
}

async function main() {
  dotenv.config({ path: resolve(process.cwd(), ".env") });
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }
  const _invGuard = assertDisposableTarget(url);
  if (!_invGuard.allowed) {
    process.stderr.write(
      `seed-inventory-load BLOCKED — ${_invGuard.reason}\n` +
      "  Set DATABASE_URL to a loopback or named scratch/test database before seeding.\n",
    );
    process.exit(1);
  }
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

  try {
    if (process.argv.includes("--purge")) {
      console.log("Purging tagged inventory load…");
      await purge(sql);
      return;
    }

    const orgCount = arg("orgs", 8);
    const variantsPerOrg = arg("variants", 400);
    const movementsPerOrg = arg("movements", 4000);
    const vendorsPerOrg = arg("vendors", 150);
    const posPerOrg = arg("pos", 600);

    const orgs = await sql`
      SELECT id, (SELECT id FROM users LIMIT 1) AS user_id
      FROM organizations ORDER BY created_at LIMIT ${orgCount}`;
    if (orgs.length === 0) throw new Error("no organizations to seed into");

    console.log(
      `Seeding ${orgs.length} orgs × ${variantsPerOrg} variants / ${movementsPerOrg} movements…`,
    );

    for (const [index, org] of orgs.entries()) {
      const suffix = `${PERF_TAG}${index}`;
      await sql.begin(async (tx) => {
        const [uom] = await tx`
          INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
          VALUES (${org.id}, ${`Perf each ${index}`}, ${suffix.slice(0, 20)}, true)
          ON CONFLICT DO NOTHING RETURNING id`;
        if (!uom) return; // already seeded for this org

        const [warehouse] = await tx`
          INSERT INTO inv_warehouses (org_id, name, code, created_by)
          VALUES (${org.id}, 'Perf warehouse', ${suffix.slice(0, 20)}, ${org.user_id})
          RETURNING id`;
        const [location] = await tx`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${org.id}, ${warehouse.id}, 'Perf bin', ${suffix.slice(0, 20)}, 'BIN')
          RETURNING id`;

        // Generated in the database rather than round-tripped: a few hundred
        // thousand inserts one statement at a time is the slow way to find out
        // your benchmark harness works.
        await tx.unsafe(
          `INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
           SELECT $1, $2, 'Perf product ' || g, $3 || '-P' || g, $4
           FROM generate_series(1, $5) g`,
          [org.id, uom.id, suffix, org.user_id, variantsPerOrg],
        );
        await tx.unsafe(
          `INSERT INTO inv_product_variants (org_id, product_id, name, sku)
           SELECT $1, p.id, 'Default', $2 || '-V' || p.id
           FROM inv_products p WHERE p.org_id = $1 AND p.sku LIKE $3`,
          [org.id, suffix, `${suffix}-P%`],
        );
        await tx.unsafe(
          `INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_hand)
           SELECT $1, v.id, $2, 100
           FROM inv_product_variants v WHERE v.org_id = $1 AND v.sku LIKE $3
           ON CONFLICT DO NOTHING`,
          [org.id, location.id, `${suffix}-V%`],
        );
        await tx.unsafe(
          `INSERT INTO inv_stock_transactions
             (org_id, product_variant_id, location_id, transaction_type,
              quantity_change, quantity_before, quantity_after, posting_date, created_by)
           SELECT $1, v.id, $2, 'ADJUSTMENT_IN', 1, 0, 1,
                  CURRENT_DATE - (g % 365), $3
           FROM generate_series(1, $4) g
           JOIN LATERAL (
             SELECT id FROM inv_product_variants
             WHERE org_id = $1 AND sku LIKE $5
             OFFSET (g % $6) LIMIT 1
           ) v ON true`,
          [org.id, location.id, org.user_id, movementsPerOrg, `${suffix}-V%`, variantsPerOrg],
        );
        // Vendors and purchase orders too. Left out of the first pass, they
        // stayed at 20 and 50 rows org-wide -- and a forbid-seq-scan assertion
        // against a 20-row table is not a finding, it is a category error.
        await tx.unsafe(
          `INSERT INTO inv_vendors (org_id, name, code, created_by)
           SELECT $1, 'Perf vendor ' || g, $2 || '-VN' || g, $3
           FROM generate_series(1, $4) g`,
          [org.id, suffix, org.user_id, vendorsPerOrg],
        );
        await tx.unsafe(
          `INSERT INTO inv_purchase_orders
             (org_id, vendor_id, po_number, order_date, status, created_by)
           SELECT $1, v.id, $2 || '-PO' || g, CURRENT_DATE - (g % 365), 'DRAFT', $3
           FROM generate_series(1, $4) g
           JOIN LATERAL (
             SELECT id FROM inv_vendors
             WHERE org_id = $1 AND code LIKE $5
             OFFSET (g % $6) LIMIT 1
           ) v ON true`,
          [org.id, suffix, org.user_id, posPerOrg, `${suffix}-VN%`, vendorsPerOrg],
        );
      });
      console.log(`  org ${index + 1}/${orgs.length} seeded`);
    }

    // Stale statistics make the planner refuse an index it should use, which
    // would read as a budget failure caused by the benchmark itself.
    console.log("Analyzing…");
    for (const table of [
      "inv_products",
      "inv_product_variants",
      "inv_stock_levels",
      "inv_stock_transactions",
      "inv_vendors",
      "inv_purchase_orders",
    ]) {
      await sql.unsafe(`VACUUM ANALYZE ${table}`);
    }
    console.log("Done.");
  } finally {
    await sql.end();
  }
}

await main();
