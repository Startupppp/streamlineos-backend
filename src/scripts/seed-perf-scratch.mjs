#!/usr/bin/env node
/**
 * Third and last seeding layer for a production-shaped scratch database.
 *
 * Layer 1 `src/scripts/seed-scratch-e2e.mjs`    — tenants, build, HR, chat, KB, accounting.
 * Layer 2 `test/perf/seed-heavy-query-load.mjs` — calendar, notifications, KB chunks at 3 sizes.
 * Layer 3 this script                           — the tables neither layer touches, and the
 *                                                 tenant skew both layers leave behind.
 *
 * Why layer 3 exists. After layers 1 and 2 the CRM, inventory, finance and Build
 * product tables are still empty, so a fifth of the read-cost budgets report
 * `seed-too-small` and their plans are unmeasurable. Worse, most tenant-scoped
 * tables hold rows for exactly one organization. A column with one distinct value
 * is not a tenant column to the planner: `org_id = $1` looks free, every
 * org-leading index looks perfect, and row-level security's post-filter costs
 * nothing because it removes nothing. A single-tenant seed does not merely
 * under-measure — it measures the wrong thing.
 *
 * So every table here is written for four organizations on a deliberately skewed
 * split, and the two smallest exist to be measured as, not to pad a row count.
 *
 * Usage:
 *   SCRATCH_DATABASE_URL=<owner url to a scratch database> \
 *     node src/scripts/seed-perf-scratch.mjs [--scale=1] [--purge]
 *
 * Idempotent: every section tops a table up to its target and inserts nothing when
 * already at it. Every failure is recorded and the process exits non-zero — a seed
 * that swallows its errors reports a shape the database does not have.
 */

import postgres from "postgres";
import * as dotenv from "dotenv";
import { resolve } from "node:path";

dotenv.config({ path: resolve(process.cwd(), ".env") });

export const LARGE_ORG = "aaaaaaaa-1111-0000-0000-000000000001";
export const SMALL_ORG = "aaaaaaaa-1111-0000-0000-000000000002";
export const MID_ORG = "aaaaaaaa-1111-0000-0000-000000000003";
export const TINY_ORG = "aaaaaaaa-1111-0000-0000-000000000004";

/**
 * The weights are the point of the script. `large` is the majority tenant every
 * naive benchmark accidentally measures; `tiny` is the one that shows what a
 * customer with a few hundred rows actually experiences behind the same indexes.
 */
export const PERF_ORGS = [
  { id: LARGE_ORG, label: "large", weight: 1, name: "Scratch E2E Corp", slug: "scratch-e2e-corp" },
  { id: MID_ORG, label: "mid", weight: 0.1, name: "Scratch Mid Org", slug: "scratch-mid-org" },
  { id: SMALL_ORG, label: "small", weight: 0.01, name: "Scratch Minority Org", slug: "scratch-minority-org" },
  { id: TINY_ORG, label: "tiny", weight: 0.002, name: "Scratch Tiny Org", slug: "scratch-tiny-org" },
];

/** Base volumes, expressed for the majority tenant; every other org is a weighted share. */
export const BASE = {
  businessParties: 20000,
  contacts: 8000,
  leads: 8000,
  deals: 6000,
  invVendors: 400,
  invProducts: 5000,
  invVariants: 12000,
  invLocations: 200,
  invStockTransactions: 150000,
  invPurchaseOrders: 2000,
  roadmapItems: 400,
  feedbackPosts: 1500,
  changelogEntries: 400,
  taxPayments: 300,
  reminderPolicies: 12,
  tickets: 18500,
  chatChannels: 50,
  chatMessages: 12000,
  supportTickets: 3000,
  timesheets: 4000,
  leaveRequests: 1200,
  attendance: 9000,
  mailMessages: 4000,
  hrPeople: 5100,
  members: 500,
};

/** A weighted share never collapses to zero: a tenant with no rows cannot be measured. */
export function scaled(base, weight, scale) {
  return Math.max(1, Math.round(base * weight * scale));
}

/**
 * The database name is checked and the URL compared against every live URL, because
 * "point this somewhere safe" is advice and this script writes several hundred
 * thousand rows and, with --purge, deletes them.
 */
export function assertScratchTarget(scratchUrl, liveUrls) {
  let database;
  try {
    database = new URL(scratchUrl).pathname.replace(/^\//, "").split("?")[0];
  } catch {
    return { ok: false, reason: "SCRATCH_DATABASE_URL is not a parseable URL" };
  }
  if (!/scratch/i.test(database))
    return {
      ok: false,
      reason: `refusing database "${database}" — SCRATCH_DATABASE_URL must name a scratch database (its name must contain "scratch")`,
    };
  for (const live of liveUrls)
    if (live && live === scratchUrl)
      return { ok: false, reason: "SCRATCH_DATABASE_URL is identical to a live database URL" };
  return { ok: true, database };
}

/**
 * Spreading N new rows over a pool of parents with `OFFSET (g % poolSize) LIMIT 1` inside a
 * LATERAL costs one partial scan of the pool per generated row — 150,000 transactions over
 * 12,000 stock levels is ~900M tuple reads and does not finish. A numbered pool joined on
 * the modulus is one hash join. This returns the CTE text; the caller passes the pool size
 * as a parameter rather than making the planner recompute count(*) per row.
 */
export function numberedPool(name, table, where) {
  return `${name} AS (SELECT *, (row_number() OVER ()) - 1 AS rn FROM (SELECT * FROM ${table} WHERE ${where}) q)`;
}

if (process.argv.includes("--self-test")) {
  const cases = [
    ["rejects the live database name", assertScratchTarget("postgres://u:p@h/neondb", []).ok, false],
    ["accepts a scratch database name", assertScratchTarget("postgres://u:p@h/scratch_perf_seed", []).ok, true],
    ["rejects a url identical to a live url", assertScratchTarget("postgres://u:p@h/scratch_x", ["postgres://u:p@h/scratch_x"]).ok, false],
    ["rejects an unparseable url", assertScratchTarget("not a url", []).ok, false],
    ["a weight never collapses a tenant to zero rows", scaled(100, 0.0001, 1) >= 1, true],
    ["weights are proportional", scaled(1000, 0.1, 1), 100],
    ["scale is proportional", scaled(1000, 1, 0.25), 250],
    ["four organizations are seeded", PERF_ORGS.length, 4],
    ["the majority tenant holds under 90% of the weight",
      PERF_ORGS[0].weight / PERF_ORGS.reduce((s, o) => s + o.weight, 0) < 0.9, true],
    ["the smallest tenant is a real fraction, not zero",
      PERF_ORGS[3].weight > 0, true],
    ["the numbered pool carries a zero-based row number",
      numberedPool("p", "t", "org_id = $1").includes("(row_number() OVER ()) - 1 AS rn"), true],
  ];
  let failed = false;
  for (const [label, actual, wanted] of cases) {
    if (actual === wanted) console.log(`  [pass] ${label}`);
    else {
      console.error(`  [FAIL] ${label}: expected ${wanted}, got ${actual}`);
      failed = true;
    }
  }
  console.log(failed ? "\nSELF-TEST FAILED" : "\nSELF-TEST PASSED");
  process.exit(failed ? 1 : 0);
}

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run against NODE_ENV=production.");
  process.exit(1);
}

const SCRATCH_URL = process.env.SCRATCH_DATABASE_URL;
if (!SCRATCH_URL) {
  console.error("SCRATCH_DATABASE_URL is required (owner role — RLS is bypassed during load).");
  process.exit(1);
}
const target = assertScratchTarget(SCRATCH_URL, [
  process.env.DATABASE_URL,
  process.env.DIRECT_DATABASE_URL,
  process.env.APP_DATABASE_URL,
]);
if (!target.ok) {
  console.error(`seed-perf-scratch: ${target.reason}`);
  process.exit(1);
}

const scaleArg = process.argv.find((a) => a.startsWith("--scale="));
const SCALE = scaleArg ? Number(scaleArg.slice("--scale=".length)) : 1;
if (!Number.isFinite(SCALE) || SCALE <= 0) {
  console.error("--scale must be a positive number");
  process.exit(1);
}
const PURGE = process.argv.includes("--purge");

const ssl = SCRATCH_URL.includes("sslmode=disable") ? false : "require";
const sql = postgres(SCRATCH_URL, { max: 1, prepare: false, ssl, onnotice: () => {} });

const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);
const failures = [];

async function section(label, fn) {
  try {
    await fn();
  } catch (e) {
    const message = e?.message ?? String(e);
    console.error(`[${((Date.now() - started) / 1000).toFixed(1)}s] FAIL ${label}: ${message}`);
    failures.push({ label, message });
  }
}

const one = async (q, params = []) => (await sql.unsafe(q, params))[0];
const count = async (table, where, params) =>
  Number((await sql.unsafe(`SELECT count(*)::bigint n FROM ${table} WHERE ${where}`, params))[0].n);

/** Tops a table up to `want` rows for one org, and reports what it did. */
async function topUp(label, table, where, params, want, insert) {
  const have = await count(table, where, params);
  if (have >= want) return have;
  await insert(have, want - have);
  const now = await count(table, where, params);
  log(`  ${label}: ${have} -> ${now}`);
  return now;
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

/**
 * `organizations.owner_membership_id` and `organization_members.org_id` reference each
 * other, so neither row can be inserted first. The FK is DEFERRABLE INITIALLY DEFERRED
 * precisely so both can go in one transaction and be checked at commit; SET CONSTRAINTS
 * makes that explicit rather than relying on the constraint's declared default.
 */
async function ensureOrg(profile) {
  if (await one(`SELECT id FROM organizations WHERE id = $1`, [profile.id])) return;

  const userId = `${profile.label}-owner-scratch-perf`;
  await sql.unsafe(
    `INSERT INTO users (id, name, email, first_name, last_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Owner', now(), now()) ON CONFLICT (id) DO NOTHING`,
    [userId, `${profile.label} Owner`, `${profile.label}-owner@scratch-seed.test`, profile.label],
  );
  const { next_id: nextId } = await one(`SELECT nextval('organization_members_id_seq') AS next_id`);
  await sql.begin(async (tx) => {
    await tx.unsafe("SET CONSTRAINTS ALL DEFERRED");
    await tx.unsafe(
      `INSERT INTO organizations (id, name, slug, status, owner_membership_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'ACTIVE', $4, now(), now()) ON CONFLICT (id) DO NOTHING`,
      [profile.id, profile.name, profile.slug, nextId],
    );
    await tx.unsafe(
      `INSERT INTO organization_members (id, user_id, org_id, role, is_owner, status, joined_at)
       VALUES ($1, $2, $3, 'OWNER', true, 'ACTIVE', now()) ON CONFLICT DO NOTHING`,
      [nextId, userId, profile.id],
    );
  });
  log(`  created org ${profile.label} with owner membership ${nextId}`);
}

/** Members are the join target of half the budgets; a one-member org measures nothing. */
async function ensureMembers(ctx, want) {
  await topUp(`${ctx.label} organization_members`, "organization_members", "org_id = $1 AND status = 'ACTIVE'", [ctx.org], want, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO users (id, name, email, first_name, last_name, created_at, updated_at)
       SELECT $1 || '-u' || g, 'Perf User ' || g, $1 || '-u' || g || '@scratch-seed.test', 'Perf', 'User ' || g, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT (id) DO NOTHING`,
      [ctx.label, have, need],
    );
    await sql.unsafe(
      `INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
       SELECT $1 || '-u' || g, $2, 'MEMBER', false, 'ACTIVE', now()
       FROM generate_series($3::int + 1, $3::int + $4::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.label, ctx.org, have, need],
    );
  });
  const rows = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id`,
    [ctx.org],
  );
  ctx.memberCount = rows.length;
  ctx.membership = rows[0]?.id ?? null;
  ctx.userId = rows[0]?.user_id ?? null;
}

const MEMBER_POOL = numberedPool("mem", "organization_members", "org_id = $1 AND status = 'ACTIVE'");

/**
 * The vocabulary DEFAULT_PROJECT_STATUSES provisions and ACTIVE_TICKET_STATUSES filters on.
 * LEGACY_STATUS_NAMES repairs a database seeded before this was corrected: the composite FK
 * build.tickets(org_id, project_id, status) -> build.project_statuses(...) is ON UPDATE CASCADE,
 * so renaming the status row carries every ticket with it.
 */
const PROJECT_STATUSES = [["TODO", "unstarted"], ["IN_PROGRESS", "started"], ["IN_REVIEW", "started"], ["DONE", "completed"]];
const LEGACY_STATUS_NAMES = [["Todo", "TODO"], ["In Progress", "IN_PROGRESS"], ["In Review", "IN_REVIEW"], ["Done", "DONE"]];

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------

async function seedCrm(ctx) {
  const parties = scaled(BASE.businessParties, ctx.weight, SCALE);
  await topUp(`${ctx.label} business_parties`, "business_parties", "organization_id = $1", [ctx.org], parties, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO business_parties (party_id, organization_id, name, party_type, email, created_at, updated_at)
       SELECT $1 || '-party-' || g, $1, 'Party ' || g,
              (ARRAY['CUSTOMER','VENDOR','PARTNER','BOTH'])[1 + (g % 4)]::party_type,
              'party' || g || '@' || $1 || '.test', now() - (g || ' hours')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });

  const contacts = scaled(BASE.contacts, ctx.weight, SCALE);
  await topUp(`${ctx.label} contacts`, "contacts", "org_id = $1", [ctx.org], contacts, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO contacts (org_id, name, email, phone, company, deleted_at, created_at, updated_at)
       SELECT $1, 'Contact ' || g, 'contact' || g || '@' || $1 || '.test', '+1555' || lpad(g::text, 7, '0'),
              'Company ' || (g % 500), null, now() - (g || ' minutes')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });

  const leads = scaled(BASE.leads, ctx.weight, SCALE);
  // assigned_to_id is the column the application filters on (idx_leads_org_assigned_status leads
  // with it, and crm-inbox-queries.service.ts reads leads.assignedToId). Writing only the
  // membership id left every "assigned to me" read matching nothing.
  await topUp(`${ctx.label} leads`, "leads", "org_id = $1", [ctx.org], leads, async (have, need) => {
    await sql.unsafe(
      `WITH ${MEMBER_POOL}
       INSERT INTO leads (org_id, name, email, status, assigned_to_membership_id, assigned_to_id, deleted_at, created_at, updated_at)
       SELECT $1, 'Lead ' || g, 'lead' || g || '@' || $1 || '.test',
              (ARRAY['NEW','CONTACTED','QUALIFIED','UNQUALIFIED','CONVERTED'])[1 + (g % 5)],
              mem.id, mem.user_id, null, now() - (g || ' minutes')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN mem ON mem.rn = g % $4::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, ctx.memberCount],
    );
  });
  await sql.unsafe(
    `UPDATE leads l SET assigned_to_id = om.user_id
     FROM organization_members om
     WHERE l.org_id = $1 AND om.org_id = l.org_id AND om.id = l.assigned_to_membership_id
       AND l.assigned_to_id IS NULL AND om.user_id IS NOT NULL`,
    [ctx.org],
  );

  const deals = scaled(BASE.deals, ctx.weight, SCALE);
  await topUp(`${ctx.label} deals`, "deals", "org_id = $1", [ctx.org], deals, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO deals (org_id, name, value_minor, stage, party_id, assigned_to_membership_id, deleted_at, created_at, updated_at)
       SELECT $1, 'Deal ' || g, ((g % 90) + 1) * 100000,
              (ARRAY['LEAD','QUALIFIED','PROPOSAL','NEGOTIATION','WON','LOST'])[1 + (g % 6)],
              $1 || '-party-' || (1 + (g % $4::int)), $5::int, null,
              now() - (g || ' minutes')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, parties, ctx.membership],
    );
  });
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

async function seedInventory(ctx) {
  const createdBy = ctx.userId;
  if (!createdBy) throw new Error("no member to attribute inventory rows to");

  const vendors = scaled(BASE.invVendors, ctx.weight, SCALE);
  await topUp(`${ctx.label} inv_vendors`, "inv_vendors", "org_id = $1", [ctx.org], vendors, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO inv_vendors (org_id, name, code, created_by, created_at, updated_at)
       SELECT $1, 'Vendor ' || g, 'V-' || $1 || '-' || g, $4, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, createdBy],
    );
  });
  const vendorCount = await count("inv_vendors", "org_id = $1", [ctx.org]);

  await topUp(`${ctx.label} inv_warehouses`, "inv_warehouses", "org_id = $1", [ctx.org], 2, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO inv_warehouses (org_id, name, code, created_by, created_at, updated_at)
       SELECT $1, 'Warehouse ' || g, 'WH-' || $1 || '-' || g, $4, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, createdBy],
    );
  });
  const warehouseId = (await one(`SELECT id FROM inv_warehouses WHERE org_id = $1 ORDER BY id LIMIT 1`, [ctx.org]))?.id;

  const locations = scaled(BASE.invLocations, ctx.weight, SCALE);
  await topUp(`${ctx.label} inv_locations`, "inv_locations", "org_id = $1", [ctx.org], locations, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, created_at, updated_at)
       SELECT $1, $4::int, 'Loc ' || g, 'L-' || $1 || '-' || g,
              (ARRAY['ZONE','AISLE','RACK','BIN'])[1 + (g % 4)]::inv_location_type, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, warehouseId],
    );
  });
  const locationCount = await count("inv_locations", "org_id = $1", [ctx.org]);

  const products = scaled(BASE.invProducts, ctx.weight, SCALE);
  await topUp(`${ctx.label} inv_products`, "inv_products", "org_id = $1", [ctx.org], products, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO inv_products (org_id, name, sku, created_by, created_at, updated_at)
       SELECT $1, 'Product ' || g, 'SKU-' || $1 || '-' || g, $4, now() - (g || ' minutes')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, createdBy],
    );
  });
  const productCount = await count("inv_products", "org_id = $1", [ctx.org]);

  const variants = scaled(BASE.invVariants, ctx.weight, SCALE);
  await topUp(`${ctx.label} inv_product_variants`, "inv_product_variants", "org_id = $1", [ctx.org], variants, async (have, need) => {
    await sql.unsafe(
      `WITH ${numberedPool("prod", "inv_products", "org_id = $1")}
       INSERT INTO inv_product_variants (org_id, product_id, name, sku, created_at, updated_at)
       SELECT $1, prod.id, 'Variant ' || g, 'VAR-' || $1 || '-' || g, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN prod ON prod.rn = g % $4::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, Math.max(1, productCount)],
    );
  });

  // The natural key is (org_id, product_variant_id, location_id): one row per pair.
  await topUp(`${ctx.label} inv_stock_levels`, "inv_stock_levels", "org_id = $1", [ctx.org], variants, async (have, need) => {
    await sql.unsafe(
      `WITH ${numberedPool("loc", "inv_locations", "org_id = $1")},
            v AS (SELECT id, (row_number() OVER (ORDER BY id)) - 1 AS rn FROM inv_product_variants WHERE org_id = $1)
       INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_hand, committed, updated_at)
       SELECT $1, v.id, loc.id, 50 + (v.id % 500), (v.id % 7), now()
       FROM v JOIN loc ON loc.rn = v.rn % $4::int
       WHERE v.rn >= $2::int AND v.rn < $2::int + $3::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, Math.max(1, locationCount)],
    );
  });
  const levelCount = await count("inv_stock_levels", "org_id = $1", [ctx.org]);

  // chk_inv_stock_transactions_arithmetic requires after = before + change, and
  // chk_inv_stock_transactions_nonzero rejects a zero delta. Both are computed, never guessed.
  const txns = scaled(BASE.invStockTransactions, ctx.weight, SCALE);
  await topUp(`${ctx.label} inv_stock_transactions`, "inv_stock_transactions", "org_id = $1", [ctx.org], txns, async (have, need) => {
    await sql.unsafe(
      `WITH lvl AS (SELECT product_variant_id, location_id, (row_number() OVER (ORDER BY id)) - 1 AS rn
                    FROM inv_stock_levels WHERE org_id = $1)
       INSERT INTO inv_stock_transactions
         (org_id, product_variant_id, location_id, transaction_type, quantity_change,
          quantity_before, quantity_after, created_by, created_at)
       SELECT $1, lvl.product_variant_id, lvl.location_id,
              (ARRAY['PURCHASE','SALE','ADJUSTMENT_IN','ADJUSTMENT_OUT','GRN','CYCLE_COUNT_GAIN'])[1 + (g % 6)]::inv_txn_type,
              d.delta, 1000, 1000 + d.delta, $4, now() - (g || ' seconds')::interval
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN lvl ON lvl.rn = g % $5::int
       CROSS JOIN LATERAL (SELECT (CASE WHEN g % 2 = 0 THEN 1 + (g % 40) ELSE -(1 + (g % 40)) END)::numeric AS delta) d
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, createdBy, Math.max(1, levelCount)],
    );
  });

  const pos = scaled(BASE.invPurchaseOrders, ctx.weight, SCALE);
  await topUp(`${ctx.label} inv_purchase_orders`, "inv_purchase_orders", "org_id = $1", [ctx.org], pos, async (have, need) => {
    await sql.unsafe(
      `WITH ${numberedPool("vend", "inv_vendors", "org_id = $1")}
       INSERT INTO inv_purchase_orders (org_id, vendor_id, po_number, order_date, created_by, created_at, updated_at)
       SELECT $1, vend.id, 'PO-' || $1 || '-' || g,
              (CURRENT_DATE - ((g % 365) || ' days')::interval)::date, $4, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN vend ON vend.rn = g % $5::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, createdBy, Math.max(1, vendorCount)],
    );
  });
}

// ---------------------------------------------------------------------------
// Build product surfaces
// ---------------------------------------------------------------------------

async function seedBuildProduct(ctx) {
  const ws = await one(
    `INSERT INTO build.pm_workspaces (pm_workspace_id, org_id, name, slug, is_default, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'Perf Workspace', 'perf', true, 'active', now(), now())
     ON CONFLICT DO NOTHING RETURNING pm_workspace_id`,
    [ctx.org],
  );
  const wsId = ws?.pm_workspace_id
    ?? (await one(`SELECT pm_workspace_id FROM build.pm_workspaces WHERE org_id = $1 LIMIT 1`, [ctx.org]))?.pm_workspace_id;
  if (!wsId) throw new Error("no pm_workspace for org");

  const proj = await one(
    `INSERT INTO build.projects (org_id, name, key, status, pm_workspace_id, manager_membership_id, created_at, updated_at)
     VALUES ($1, 'Perf Project', 'PERF', 'ACTIVE', $2, $3, now(), now())
     ON CONFLICT DO NOTHING RETURNING id`,
    [ctx.org, wsId, ctx.membership],
  );
  const projectId = proj?.id
    ?? (await one(`SELECT id FROM build.projects WHERE org_id = $1 AND key = 'PERF'`, [ctx.org]))?.id;
  if (!projectId) throw new Error("no build project for org");

  // build.tickets.status is a composite FK to build.project_statuses(org_id, project_id, name),
  // so a ticket cannot carry a status its project has not declared. The names must be the ones
  // the application writes — src/modules/build/core/lib/default-statuses.ts DEFAULT_PROJECT_STATUSES
  // and src/modules/dashboard/dashboard-personal.service.ts ACTIVE_TICKET_STATUSES both use
  // UPPER_SNAKE. This seed wrote title-case, so every query filtering on the application's own
  // status vocabulary matched zero rows and read as a broken query rather than a broken fixture.
  for (const [legacy, canonical] of LEGACY_STATUS_NAMES) {
    await sql.unsafe(
      `UPDATE build.project_statuses SET name = $3 WHERE org_id = $1 AND project_id = $2::int AND name = $4`,
      [ctx.org, projectId, canonical, legacy],
    );
  }
  for (let i = 0; i < PROJECT_STATUSES.length; i++) {
    await sql.unsafe(
      `INSERT INTO build.project_statuses (org_id, project_id, name, "order", type, created_at, updated_at)
       VALUES ($1, $2::int, $3, $4, $5::state_group, now(), now())
       ON CONFLICT DO NOTHING`,
      [ctx.org, projectId, PROJECT_STATUSES[i][0], i + 1, PROJECT_STATUSES[i][1]],
    );
  }

  await sql.unsafe(
    `INSERT INTO build.sprints (org_id, project_id, name, status, start_date, end_date, created_at, updated_at)
     VALUES ($1, $2, 'Perf Sprint', 'ACTIVE', CURRENT_DATE - INTERVAL '7 days', CURRENT_DATE + INTERVAL '7 days', now(), now())
     ON CONFLICT DO NOTHING`,
    [ctx.org, projectId],
  );

  await topUp(`${ctx.label} build.project_members`, "build.project_members", "org_id = $1", [ctx.org], Math.min(20, ctx.memberCount), async () => {
    await sql.unsafe(
      `INSERT INTO build.project_members (org_id, project_id, membership_id, role, joined_at)
       SELECT $1, $2::int, m.id, 'MEMBER', now()
       FROM (SELECT id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 20) m
       ON CONFLICT DO NOTHING`,
      [ctx.org, projectId],
    );
  });

  // build.tickets is the most-read table in the budget catalog and, before this layer,
  // every one of its 18,500 rows belonged to one organization.
  const tickets = scaled(BASE.tickets, ctx.weight, SCALE);
  await topUp(`${ctx.label} build.tickets`, "build.tickets", "org_id = $1 AND deleted_at IS NULL", [ctx.org], tickets, async (have, need) => {
    const base = Number((await one(`SELECT coalesce(max(ticket_number), 0)::int n FROM build.tickets WHERE org_id = $1`, [ctx.org])).n);
    await sql.unsafe(
      `WITH ${MEMBER_POOL}
       INSERT INTO build.tickets (org_id, project_id, title, status, assignee_membership_id, reporter_membership_id, ticket_number, deleted_at, created_at, updated_at)
       SELECT $1, $2::int, 'Perf ticket ' || g || ' payment refund latency',
              (ARRAY['TODO','IN_PROGRESS','IN_REVIEW','DONE'])[1 + (g % 4)],
              mem.id, $6::int, $5::int + g, null, now() - (g || ' minutes')::interval, now()
       FROM generate_series($3::int + 1, $3::int + $4::int) g
       JOIN mem ON mem.rn = g % $7::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, projectId, have, need, base, ctx.membership, ctx.memberCount],
    );
  });

  await topUp(`${ctx.label} build.ticket_assignees`, "build.ticket_assignees", "org_id = $1", [ctx.org], Math.min(500, tickets), async (have, need) => {
    await sql.unsafe(
      `INSERT INTO build.ticket_assignees (org_id, ticket_id, membership_id, assigned_at)
       SELECT $1, t.id, t.assignee_membership_id, now()
       FROM (SELECT id, assignee_membership_id FROM build.tickets
             WHERE org_id = $1 AND assignee_membership_id IS NOT NULL
             ORDER BY id OFFSET $2::int LIMIT $3::int) t
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });

  for (const [table, base, noun] of [
    ["build.roadmap_items", BASE.roadmapItems, "Roadmap item"],
    ["build.feedback_posts", BASE.feedbackPosts, "Feedback"],
    ["build.changelog_entries", BASE.changelogEntries, "Changelog"],
  ]) {
    const want = scaled(base, ctx.weight, SCALE);
    await topUp(`${ctx.label} ${table}`, table, "org_id = $1", [ctx.org], want, async (have, need) => {
      await sql.unsafe(
        `INSERT INTO ${table} (org_id, title, created_at, updated_at)
         SELECT $1, $4 || ' ' || g, now() - (g || ' hours')::interval, now()
         FROM generate_series($2::int + 1, $2::int + $3::int) g`,
        [ctx.org, have, need, noun],
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

async function seedFinance(ctx) {
  const payments = scaled(BASE.taxPayments, ctx.weight, SCALE);
  await topUp(`${ctx.label} acc_tax_payments`, "acc_tax_payments", "org_id = $1", [ctx.org], payments, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO acc_tax_payments (org_id, tax_type, period_start, period_end, amount, created_by, created_at)
       SELECT $1, (ARRAY['GST','CGST_SGST','IGST','VAT','TDS'])[1 + (g % 5)]::acc_tax_type,
              date_trunc('month', CURRENT_DATE - ((g % 24) || ' months')::interval)::date,
              (date_trunc('month', CURRENT_DATE - ((g % 24) || ' months')::interval) + interval '1 month - 1 day')::date,
              1000 + (g % 90000), $4, now() - (g || ' hours')::interval
       FROM generate_series($2::int + 1, $2::int + $3::int) g`,
      [ctx.org, have, need, ctx.userId],
    );
  });

  const policies = scaled(BASE.reminderPolicies, ctx.weight, SCALE);
  await topUp(`${ctx.label} fin_reminder_policies`, "fin_reminder_policies", "org_id = $1", [ctx.org], policies, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO fin_reminder_policies (org_id, name, offsets, created_at, updated_at)
       SELECT $1, 'Reminder policy ' || g, '[-7,-1,3,7]'::jsonb, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });
}

// ---------------------------------------------------------------------------
// Minority slices of the tables layer 1 filled for the majority tenant only
// ---------------------------------------------------------------------------

async function seedChat(ctx) {
  const channels = Math.max(3, scaled(BASE.chatChannels, ctx.weight, SCALE));
  await topUp(`${ctx.label} chat_channels`, "chat_channels", "org_id = $1", [ctx.org], channels, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO chat_channels (org_id, name, type, is_private, created_at, updated_at)
       SELECT $1, 'perf-channel-' || g, 'GROUP', true, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });
  const channelCount = await count("chat_channels", "org_id = $1", [ctx.org]);
  if (channelCount === 0) throw new Error("no chat channel for org");

  await topUp(`${ctx.label} chat_channel_members`, "chat_channel_members", "org_id = $1", [ctx.org], Math.max(5, scaled(500, ctx.weight, SCALE)), async () => {
    await sql.unsafe(
      `INSERT INTO chat_channel_members (org_id, channel_id, membership_id, joined_at)
       SELECT $1, c.id, m.id, now()
       FROM (SELECT id FROM chat_channels WHERE org_id = $1 ORDER BY id LIMIT 10) c
       CROSS JOIN (SELECT id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 50) m
       ON CONFLICT DO NOTHING`,
      [ctx.org],
    );
  });

  const msgs = scaled(BASE.chatMessages, ctx.weight, SCALE);
  await topUp(`${ctx.label} chat_messages`, "chat_messages", "org_id = $1", [ctx.org], msgs, async (have, need) => {
    await sql.unsafe(
      `WITH ${MEMBER_POOL},
            ${numberedPool("chan", "chat_channels", "org_id = $1")}
       INSERT INTO chat_messages (org_id, channel_id, sender_membership_id, content, is_deleted, created_at, updated_at)
       SELECT $1, chan.id, mem.id, 'Perf message ' || g, false, now() - (g || ' seconds')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN mem ON mem.rn = g % $4::int
       JOIN chan ON chan.rn = g % $5::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, ctx.memberCount, channelCount],
    );
  });

  await topUp(`${ctx.label} chat_saved_messages`, "chat_saved_messages", "org_id = $1", [ctx.org], Math.max(5, scaled(200, ctx.weight, SCALE)), async (have, need) => {
    await sql.unsafe(
      `INSERT INTO chat_saved_messages (org_id, membership_id, message_id, saved_at)
       SELECT $1, msg.sender_membership_id, msg.id, now()
       FROM (SELECT id, sender_membership_id FROM chat_messages
             WHERE org_id = $1 AND sender_membership_id IS NOT NULL
             ORDER BY id OFFSET $2::int LIMIT $3::int) msg
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });
}

async function seedHr(ctx) {
  const people = scaled(BASE.hrPeople, ctx.weight, SCALE);
  await topUp(`${ctx.label} hr_people`, "hr_people", "org_id = $1", [ctx.org], people, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO hr_people (org_id, created_at, updated_at)
       SELECT $1, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g`,
      [ctx.org, have, need],
    );
  });

  await topUp(`${ctx.label} hr_employments`, "hr_employments", "org_id = $1", [ctx.org], people, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO hr_employments (org_id, person_id, employee_number, lifecycle_status, created_at, updated_at)
       SELECT $1, p.id, 'EMP-' || $1 || '-' || p.id, 'ACTIVE'::hr_employment_lifecycle_status, now(), now()
       FROM (SELECT id FROM hr_people WHERE org_id = $1 ORDER BY id OFFSET $2::int LIMIT $3::int) p
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });

  const leaveTypeId = (await one(`SELECT id FROM leave_types WHERE org_id = $1 ORDER BY id LIMIT 1`, [ctx.org]))?.id
    ?? (await one(
      `INSERT INTO leave_types (org_id, name, days_per_year)
       VALUES ($1, 'Annual', 24) ON CONFLICT DO NOTHING RETURNING id`,
      [ctx.org],
    ))?.id;
  if (!leaveTypeId) throw new Error("no leave_type for org");

  const leaves = scaled(BASE.leaveRequests, ctx.weight, SCALE);
  await topUp(`${ctx.label} leave_requests`, "leave_requests", "org_id = $1", [ctx.org], leaves, async (have, need) => {
    await sql.unsafe(
      `WITH ${MEMBER_POOL}
       INSERT INTO leave_requests (org_id, user_id, user_membership_id, leave_type_id, start_date, end_date, status, created_at, updated_at)
       SELECT $1, mem.user_id, mem.id, $4::int,
              (CURRENT_DATE - ((g % 200) || ' days')::interval)::date,
              (CURRENT_DATE - ((g % 200) || ' days')::interval + interval '1 day')::date,
              (ARRAY['PENDING','APPROVED','REJECTED'])[1 + (g % 3)]::leave_status,
              now() - (g || ' minutes')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN mem ON mem.rn = g % $5::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, leaveTypeId, ctx.memberCount],
    );
  });

  await topUp(`${ctx.label} leave_balances`, "leave_balances", "org_id = $1", [ctx.org], Math.max(5, scaled(500, ctx.weight, SCALE)), async (have, need) => {
    await sql.unsafe(
      `INSERT INTO leave_balances (org_id, user_id, user_membership_id, leave_type_id, year, balance)
       SELECT $1, m.user_id, m.id, $4::int, 2026, 24 - (m.id % 12)
       FROM (SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'
             ORDER BY id OFFSET $2::int LIMIT $3::int) m
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, leaveTypeId],
    );
  });

  await topUp(`${ctx.label} hr_leave_ledger`, "hr_leave_ledger", "org_id = $1", [ctx.org], Math.max(5, scaled(500, ctx.weight, SCALE)), async (have, need) => {
    await sql.unsafe(
      `INSERT INTO hr_leave_ledger (org_id, user_id, user_membership_id, leave_type_id, txn_type, days, effective_date, source, created_at)
       SELECT $1, m.user_id, m.id, $4::int, 'accrual'::hr_leave_txn_type, 2,
              (CURRENT_DATE - ((m.id % 300) || ' days')::interval)::date,
              'policy_accrual'::hr_leave_ledger_source, now()
       FROM (SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'
             ORDER BY id OFFSET $2::int LIMIT $3::int) m
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, leaveTypeId],
    );
  });

  const att = scaled(BASE.attendance, ctx.weight, SCALE);
  await topUp(`${ctx.label} attendance`, "attendance", "org_id = $1", [ctx.org], att, async (have, need) => {
    await sql.unsafe(
      `WITH ${MEMBER_POOL}
       INSERT INTO attendance (org_id, user_id, user_membership_id, date, status, created_at)
       SELECT $1, mem.user_id, mem.id, (CURRENT_DATE - ((g % 180) || ' days')::interval)::date,
              (ARRAY['PRESENT','ABSENT','LEAVE','HALF_DAY'])[1 + (g % 4)], now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN mem ON mem.rn = g % $4::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, ctx.memberCount],
    );
  });

  const ts = scaled(BASE.timesheets, ctx.weight, SCALE);
  await topUp(`${ctx.label} timesheets`, "timesheets", "org_id = $1", [ctx.org], ts, async (have, need) => {
    await sql.unsafe(
      `WITH ${MEMBER_POOL}
       INSERT INTO timesheets (org_id, user_membership_id, date, hours, status, created_at, updated_at)
       SELECT $1, mem.id, (CURRENT_DATE - ((g % 180) || ' days')::interval)::date, 8,
              (ARRAY['PENDING','APPROVED','REJECTED'])[1 + (g % 3)]::timesheet_entry_status, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN mem ON mem.rn = g % $4::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, ctx.memberCount],
    );
  });
}

async function seedSupport(ctx) {
  const tickets = scaled(BASE.supportTickets, ctx.weight, SCALE);
  await topUp(`${ctx.label} support_tickets`, "support_tickets", "org_id = $1", [ctx.org], tickets, async (have, need) => {
    await sql.unsafe(
      `WITH ${MEMBER_POOL}
       INSERT INTO support_tickets
         (org_id, title, status, priority, assignee_membership_id, source_channel,
          created_by_membership_id, sla_paused_minutes, sla_escalation_level, created_at, updated_at)
       SELECT $1, 'Support ticket ' || g,
              (ARRAY['OPEN','IN_PROGRESS','WAITING','RESOLVED','CLOSED'])[1 + (g % 5)]::support_ticket_status,
              (ARRAY['LOW','MEDIUM','HIGH','URGENT'])[1 + (g % 4)]::support_ticket_priority,
              mem.id, 'web', $4::int, 0, 0, now() - (g || ' minutes')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN mem ON mem.rn = g % $5::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, ctx.membership, ctx.memberCount],
    );
  });
}

async function seedMail(ctx) {
  // mail_message_metadata.account_id carries no foreign key; it is a mailbox identifier,
  // and one account per organization keeps (account_id, message_id) unique.
  const existing = (await one(`SELECT min(account_id) AS id FROM mail_message_metadata WHERE org_id = $1`, [ctx.org]))?.id;
  const next = (await one(`SELECT coalesce(max(account_id), 0) + 1 AS id FROM mail_message_metadata`))?.id ?? 1;
  const accountId = existing ?? next;

  const msgs = scaled(BASE.mailMessages, ctx.weight, SCALE);
  await topUp(`${ctx.label} mail_message_metadata`, "mail_message_metadata", "org_id = $1", [ctx.org], msgs, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO mail_message_metadata (org_id, account_id, message_id, subject, is_read, date, user_membership_id, synced_at)
       SELECT $1, $4::int, 'perf-msg-' || $1 || '-' || g, 'Perf subject ' || g, (g % 3 = 0),
              now() - (g || ' minutes')::interval, $5::int, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, accountId, ctx.membership],
    );
  });
}

// ---------------------------------------------------------------------------

const TOUCHED = [
  "organizations", "users", "organization_members",
  "business_parties", "contacts", "leads", "deals",
  "inv_vendors", "inv_warehouses", "inv_locations", "inv_products", "inv_product_variants",
  "inv_stock_levels", "inv_stock_transactions", "inv_purchase_orders",
  "build.pm_workspaces", "build.projects", "build.project_statuses", "build.sprints",
  "build.project_members", "build.tickets", "build.ticket_assignees",
  "build.roadmap_items", "build.feedback_posts", "build.changelog_entries",
  "acc_tax_payments", "fin_reminder_policies",
  "chat_channels", "chat_channel_members", "chat_messages", "chat_saved_messages",
  "hr_people", "hr_employments", "leave_types", "leave_requests", "leave_balances",
  "hr_leave_ledger", "attendance", "timesheets", "support_tickets", "mail_message_metadata",
];

/** A plan read before ANALYZE is a plan against stale statistics, which is not a plan. */
async function vacuumAnalyze() {
  log("VACUUM ANALYZE...");
  for (const t of TOUCHED) {
    await sql.unsafe(`VACUUM ANALYZE ${t}`).catch((e) => {
      failures.push({ label: `vacuum ${t}`, message: e?.message ?? String(e) });
    });
  }
  log("VACUUM ANALYZE complete.");
}

const PURGEABLE = [
  "inv_stock_transactions", "inv_stock_levels", "inv_product_variants", "inv_products",
  "inv_purchase_orders", "inv_locations", "inv_warehouses", "inv_vendors",
  "deals", "leads", "contacts", "business_parties",
  "acc_tax_payments", "fin_reminder_policies", "support_tickets", "mail_message_metadata",
];

async function purge() {
  log("Purging perf-layer rows for the four seed orgs...");
  for (const o of PERF_ORGS)
    for (const t of PURGEABLE) {
      const col = t === "business_parties" ? "organization_id" : "org_id";
      await sql.unsafe(`DELETE FROM ${t} WHERE ${col} = $1`, [o.id]).catch(() => {});
    }
}

const SHAPE_TABLES = [
  "build.tickets", "notifications", "calendar_events", "event_attendees", "chat_messages",
  "contacts", "leads", "deals", "business_parties", "inv_stock_transactions", "inv_stock_levels",
  "inv_product_variants", "inv_products", "support_tickets", "attendance", "timesheets",
  "leave_requests", "mail_message_metadata", "hr_employments", "hr_people", "kb_pages",
  "kb_article_chunks", "organization_members",
];

async function reportShape() {
  console.log("\n--- TENANT SHAPE (rows per organization) ---");
  console.log([
    "table".padEnd(26),
    ...PERF_ORGS.map((o) => o.label.padStart(9)),
    "total".padStart(9),
    "majority%".padStart(10),
    "minority%".padStart(10),
  ].join(" "));
  for (const t of SHAPE_TABLES) {
    const col = t === "business_parties" ? "organization_id" : "org_id";
    const per = [];
    for (const o of PERF_ORGS) per.push(await count(t, `${col} = $1`, [o.id]).catch(() => 0));
    const all = Number((await sql.unsafe(`SELECT count(*)::bigint n FROM ${t}`))[0].n);
    const majority = all > 0 ? (per[0] / all) * 100 : 0;
    const minority = all > 0 ? ((per[2] + per[3]) / all) * 100 : 0;
    console.log([
      t.padEnd(26),
      ...per.map((n) => String(n).padStart(9)),
      String(all).padStart(9),
      `${majority.toFixed(2)}%`.padStart(10),
      `${minority.toFixed(2)}%`.padStart(10),
    ].join(" "));
  }
  const orgs = Number((await sql.unsafe(`SELECT count(*)::bigint n FROM organizations`))[0].n);
  const live = await sql.unsafe(`SELECT count(*)::bigint n FROM pg_stat_user_tables WHERE n_live_tup > 0`);
  console.log(`\norganizations: ${orgs} · non-empty tables: ${live[0].n}`);
}

async function main() {
  log(`target database ${target.database} · scale ${SCALE}`);
  if (PURGE) await purge();

  for (const profile of PERF_ORGS) await section(`ensureOrg ${profile.label}`, () => ensureOrg(profile));

  for (const profile of PERF_ORGS) {
    const ctx = { org: profile.id, label: profile.label, weight: profile.weight, memberCount: 0 };
    log(`org ${ctx.label} (weight ${ctx.weight})`);
    await section(`${ctx.label} members`, () => ensureMembers(ctx, Math.max(5, scaled(BASE.members, ctx.weight, SCALE))));
    if (!ctx.membership || ctx.memberCount === 0) {
      failures.push({ label: `${ctx.label} members`, message: "no active membership — every later section would be meaningless" });
      continue;
    }
    await section(`${ctx.label} crm`, () => seedCrm(ctx));
    await section(`${ctx.label} inventory`, () => seedInventory(ctx));
    await section(`${ctx.label} build`, () => seedBuildProduct(ctx));
    await section(`${ctx.label} finance`, () => seedFinance(ctx));
    await section(`${ctx.label} chat`, () => seedChat(ctx));
    await section(`${ctx.label} hr`, () => seedHr(ctx));
    await section(`${ctx.label} support`, () => seedSupport(ctx));
    await section(`${ctx.label} mail`, () => seedMail(ctx));
  }

  await vacuumAnalyze();
  await reportShape();

  if (failures.length > 0) {
    const grouped = new Map();
    for (const f of failures) {
      const key = `${f.label}: ${f.message.slice(0, 200)}`;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    console.log(`\nFAILURES: ${failures.length} in ${grouped.size} distinct sections`);
    for (const [k, n] of grouped) console.log(`  (x${n}) ${k}`);
    process.exitCode = 1;
  } else {
    console.log("\nAll sections completed without errors.");
  }
  log("seed-perf-scratch complete.");
}

main()
  .catch((e) => {
    console.error("SEED FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
