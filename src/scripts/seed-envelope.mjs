import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";
import {
  KEY_PREFIX, USER_EMAIL_PATTERN, ORG_PERSON_ID_PREFIX,
  seedMembers, seedHR, seedNotifications, seedChat, seedKB, seedLeave,
} from "./envelope-fixtures.mjs";
import { CELL_SHARE } from "./envelope-profile.mjs";

dotenv.config({ path: resolve(process.cwd(), ".env") });

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run against NODE_ENV=production.");
  process.exit(1);
}

const adminUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) {
  console.error("DATABASE_URL is required (owner role, to bypass RLS during load).");
  process.exit(1);
}

const ORG = process.env.SEED_ORG_ID || "aa5627a2-a7de-4dca-97d2-135f3a5f801b";
const RESET = process.argv.includes("--reset");
const ssl = process.env.PGSSLMODE === "disable" ? false : "require";
const sql = postgres(adminUrl, { max: 1, prepare: false, ssl, onnotice: () => {} });

const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

async function reset() {
  await sql`set statement_timeout = 0`;
  await sql.unsafe(`DELETE FROM chat_messages WHERE org_id = '${ORG}' AND content LIKE 'SE: seeded%'`);
  await sql.unsafe(`DELETE FROM chat_channels WHERE org_id = '${ORG}' AND name LIKE 'SE:%'`);
  await sql.unsafe(`DELETE FROM notifications WHERE org_id = '${ORG}' AND title LIKE 'SE: Notification%'`);
  await sql.unsafe(`DELETE FROM kb_pages WHERE org_id = '${ORG}' AND title LIKE 'SE Page%'`);
  await sql.unsafe(`DELETE FROM kb_spaces WHERE org_id = '${ORG}' AND name LIKE 'SE Space%'`);
  await sql.unsafe(`DELETE FROM payroll_line_items WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM payroll_run_employees WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM payroll_runs WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM inv_stock_transactions WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM inv_stock_levels WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM inv_po_lines WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM inv_purchase_orders WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM inv_product_variants WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM inv_products WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM inv_locations WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM inv_warehouses WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM inv_vendors WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM payments WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM invoices WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM purchase_bills WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM gl_journals WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM gl_periods WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM gl_fiscal_years WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM gl_books WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM clients WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM deals WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM leads WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM contacts WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM business_parties WHERE organization_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM leave_requests WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM leave_balances WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM hr_leave_ledger WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM attendance WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM hr_reporting_lines WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM hr_employments WHERE org_id = '${ORG}'`);
  await sql.unsafe(`DELETE FROM hr_people WHERE org_id = '${ORG}' AND organization_person_id LIKE '${ORG_PERSON_ID_PREFIX}%'`);
  await sql.unsafe(`DELETE FROM organization_people WHERE organization_id = '${ORG}' AND organization_person_id LIKE '${ORG_PERSON_ID_PREFIX}%'`);
  await sql.unsafe(`DELETE FROM users WHERE email LIKE '${USER_EMAIL_PATTERN}'`);
  log("reset: complete");
}

async function seedCRM(ownerUserId) {
  await sql.unsafe(`
    INSERT INTO business_parties (party_id, organization_id, name, party_type, status, created_at, updated_at)
    SELECT 'se-bp-' || lpad(g::text, 5, '0'), '${ORG}', 'SE Party ' || g, 'CUSTOMER', 'active', now(), now()
    FROM generate_series(1, 100) g ON CONFLICT DO NOTHING`);
  log("business_parties: 100");

  await sql.unsafe(`
    INSERT INTO contacts (org_id, name, email, created_at, updated_at)
    SELECT '${ORG}', 'SE Contact ' || g, 'se-contact-' || g || '@example.com', now(), now()
    FROM generate_series(1, 200) g ON CONFLICT DO NOTHING`);
  log("contacts: 200");

  await sql.unsafe(`
    INSERT INTO leads (org_id, name, email, status, assigned_to_id, created_at, updated_at)
    SELECT '${ORG}', 'SE Lead ' || g, 'se-lead-' || g || '@example.com',
      (ARRAY['visitor','lead','mql','sql'])[1 + (g % 4)]::crm_lead_status,
      '${ownerUserId}', now(), now()
    FROM generate_series(1, 200) g ON CONFLICT DO NOTHING`);
  log("leads: 200");

  await sql.unsafe(`
    INSERT INTO deals (org_id, name, stage, value_minor, expected_close_date, assigned_to_id, created_at, updated_at)
    SELECT '${ORG}', 'SE Deal ' || g,
      (ARRAY['Discovery','Qualified','Proposal','Negotiation','Closed Won'])[1 + (g % 5)]::crm_deal_stage,
      (10000 + g * 500) * 100,
      CURRENT_DATE + ((g % 90) || ' days')::interval,
      '${ownerUserId}', now(), now()
    FROM generate_series(1, 100) g ON CONFLICT DO NOTHING`);
  log("deals: 100");

  await sql.unsafe(`
    INSERT INTO clients (org_id, name, status, created_at, updated_at)
    SELECT '${ORG}', 'SE Client ' || g, 'active', now(), now()
    FROM generate_series(1, 50) g ON CONFLICT DO NOTHING`);
  log("clients: 50");
}

async function seedAccounting(ownerUserId) {
  const bookId = `se-book-${ORG.slice(0, 8)}`;
  const fyId = `se-fy-${ORG.slice(0, 8)}`;
  const periodId = `se-period-${ORG.slice(0, 8)}`;

  await sql.unsafe(`
    INSERT INTO gl_books (id, org_id, name, country_code, base_currency, localization_pack, status, is_default, created_at, updated_at)
    VALUES ('${bookId}', '${ORG}', 'SE Book', 'IN', 'INR', 'in', 'ACTIVE'::gl_book_status, true, now(), now())
    ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO gl_fiscal_years (id, org_id, book_id, name, starts_on, ends_on, status, created_at, updated_at)
    VALUES ('${fyId}', '${ORG}', '${bookId}', 'FY 2026', '2026-04-01', '2027-03-31', 'OPEN'::gl_fiscal_year_status, now(), now())
    ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO gl_periods (id, org_id, book_id, fiscal_year_id, name, starts_on, ends_on, sequence, status, created_at, updated_at)
    VALUES ('${periodId}', '${ORG}', '${bookId}', '${fyId}', 'Apr 2026', '2026-04-01', '2026-04-30', 1, 'OPEN'::gl_period_status, now(), now())
    ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO gl_journals (id, org_id, book_id, period_id, journal_number, journal_date, memo, source_type, idempotency_key)
    SELECT 'se-jnl-' || lpad(g::text, 5, '0'), '${ORG}', '${bookId}', '${periodId}',
      g::text, ('2026-04-' || lpad((1 + (g % 28))::text, 2, '0'))::date,
      'SE Journal entry ' || g, 'manual'::gl_journal_source, 'SE-JNL-' || g
    FROM generate_series(1, 50) g ON CONFLICT DO NOTHING`);
  log("gl: book + 50 journals");

  await sql.unsafe(`
    INSERT INTO invoices (org_id, invoice_number, status, subtotal, tax_rate, tax_amount, total, currency, due_date, created_by, created_at, updated_at)
    SELECT '${ORG}', 'SE-INV-' || lpad(g::text, 4, '0'), 'DRAFT'::invoice_status,
      (5000 + g * 100), 18, (5000 + g * 100) * 18 / 100, (5000 + g * 100) * 118 / 100,
      'INR', CURRENT_DATE + '30 days'::interval, '${ownerUserId}', now(), now()
    FROM generate_series(1, 50) g ON CONFLICT DO NOTHING`);
  log("invoices: 50");


  await sql.unsafe(`
    INSERT INTO purchase_bills (org_id, bill_number, bill_date, status, subtotal, tax_amount, total, currency, created_by, created_at, updated_at)
    SELECT '${ORG}', 'SE-BILL-' || lpad(g::text, 4, '0'), CURRENT_DATE - ((g % 90) || ' days')::interval,
      'DRAFT', (2000 + g * 50), (2000 + g * 50) * 18 / 100, (2000 + g * 50) * 118 / 100,
      'INR', '${ownerUserId}', now(), now()
    FROM generate_series(1, 50) g ON CONFLICT DO NOTHING`);
  log("purchase_bills: 50");
}

async function seedInventory(ownerUserId) {
  await sql.unsafe(`
    INSERT INTO inv_warehouses (org_id, name, code, is_default, is_active, created_by, created_at, updated_at)
    SELECT '${ORG}', 'SE Warehouse ' || g, 'SE-WH-' || g, (g = 1), true, '${ownerUserId}', now(), now()
    FROM generate_series(1, 3) g ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_pickable, is_receivable, is_sellable, is_active, created_at, updated_at)
    SELECT '${ORG}', w.id, 'SE Loc ' || g, 'SE-LOC-' || g, 'BIN', true, true, true, true, now(), now()
    FROM generate_series(1, 20) g
    JOIN (SELECT id FROM inv_warehouses WHERE org_id = '${ORG}' ORDER BY id LIMIT 1) w ON true
    ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO inv_vendors (org_id, name, code, is_active, created_by, created_at, updated_at)
    SELECT '${ORG}', 'SE Vendor ' || g, 'SE-VND-' || lpad(g::text, 3, '0'), true, '${ownerUserId}', now(), now()
    FROM generate_series(1, 20) g ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO inv_products (org_id, name, sku, status, product_type, tracking_method, costing_method, created_by, created_at, updated_at)
    SELECT '${ORG}', 'SE Product ' || g, 'SE-SKU-' || lpad(g::text, 4, '0'),
      'ACTIVE'::inv_product_status, 'STOCKABLE'::inv_product_type, 'NONE'::inv_tracking_method, 'WEIGHTED_AVERAGE'::inv_costing_method, '${ownerUserId}', now(), now()
    FROM generate_series(1, 100) g ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO inv_product_variants (org_id, product_id, name, sku, is_active, created_at, updated_at)
    SELECT '${ORG}', p.id, 'SE Variant ' || p.id, 'SE-VAR-' || lpad(p.id::text, 5, '0'), true, now(), now()
    FROM inv_products p WHERE p.org_id = '${ORG}' AND p.name LIKE 'SE Product%'
    ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_hand, average_cost, updated_at)
    SELECT '${ORG}', v.id, l.id, (50 + (v.id % 200)), 100, now()
    FROM inv_product_variants v
    JOIN (SELECT id FROM inv_locations WHERE org_id = '${ORG}' ORDER BY id LIMIT 1) l ON true
    WHERE v.org_id = '${ORG}' AND v.name LIKE 'SE Variant%'
    ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO inv_stock_transactions (org_id, product_variant_id, transaction_type, quantity_change, quantity_before, quantity_after, created_by, posting_date, created_at)
    SELECT '${ORG}', v.id, 'PURCHASE'::inv_txn_type,
      (10 + (v.id % 50)),
      0,
      (10 + (v.id % 50)),
      '${ownerUserId}',
      CURRENT_DATE - ((v.id % 90) || ' days')::interval,
      now()
    FROM inv_product_variants v WHERE v.org_id = '${ORG}' AND v.name LIKE 'SE Variant%'
    ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO inv_purchase_orders (org_id, vendor_id, po_number, status, order_date, created_by, created_at, updated_at)
    SELECT '${ORG}', vnd.id, 'SE-PO-' || lpad(g::text, 4, '0'), 'DRAFT'::inv_po_status,
      CURRENT_DATE - ((g % 60) || ' days')::interval, '${ownerUserId}', now(), now()
    FROM generate_series(1, 50) g
    JOIN (SELECT id FROM inv_vendors WHERE org_id = '${ORG}' ORDER BY id LIMIT 1) vnd ON true
    ON CONFLICT DO NOTHING`);
  log("inventory: vendors + products + variants + stock");
}

async function seedPayroll(ownerUserId) {
  await sql.unsafe(`
    INSERT INTO payroll_runs (org_id, month, status, run_type, created_at, updated_at)
    SELECT '${ORG}', '2026-0' || g || '-01', 'DRAFT'::payroll_run_status, 'REGULAR', now(), now()
    FROM generate_series(1, 5) g ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO payroll_run_employees (org_id, run_id, user_id, status, created_at, updated_at)
    SELECT r.org_id, r.id, '${ownerUserId}', 'DRAFT', now(), now()
    FROM payroll_runs r
    JOIN generate_series(1, 50) g ON true
    WHERE r.org_id = '${ORG}'
    LIMIT 250
    ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO payroll_line_items (org_id, run_id, run_employee_id, code, name, category, amount, calc_method, calc_explain, taxable, sort_order, created_at)
    SELECT re.org_id, re.run_id, re.id,
      'BASIC', 'Basic Salary', 'EARNING'::salary_component_type, 50000, 'FIXED'::salary_component_calc_method, '"Fixed basic salary"'::jsonb, true, 1, now()
    FROM payroll_run_employees re WHERE re.org_id = '${ORG}'
    ON CONFLICT DO NOTHING`);
  log("payroll: 5 runs + 250 employees + 250 line items");
}

async function vacuumAnalyze() {
  const tables = [
    "users","organization_members","organization_people","hr_people","hr_employments","hr_reporting_lines",
    "notifications","chat_channels","chat_channel_members","chat_messages","chat_saved_messages",
    "kb_spaces","kb_pages","kb_page_visits","leave_requests","leave_balances","hr_leave_ledger","attendance",
    "contacts","leads","deals","clients","business_parties","invoices","purchase_bills",
    "gl_books","gl_periods","gl_journals","payroll_runs","payroll_run_employees","payroll_line_items",
    "inv_products","inv_product_variants","inv_locations","inv_stock_levels","inv_stock_transactions",
    "inv_purchase_orders","inv_vendors",
  ];
  for (const t of tables)
    await sql.unsafe(`VACUUM ANALYZE ${t}`);
  log(`vacuum analyze: ${tables.length} tables`);
}

async function main() {
  await sql`set statement_timeout = 0`;
  if (RESET) await reset();

  const [{ user_id: ownerUserId }] = await sql`
    SELECT user_id FROM organization_members WHERE org_id = ${ORG} AND is_owner = true LIMIT 1`;

  const leaveTypes = await sql`SELECT id FROM leave_types WHERE org_id = ${ORG}`;
  const leaveTypeIds = leaveTypes.map((r) => r.id);

  const MEMBER_COUNT = CELL_SHARE.largestOrgMembers;
  log(`seeding ${MEMBER_COUNT} members in org ${ORG}`);

  await seedMembers(sql, ORG, MEMBER_COUNT, 25000);
  log("members: done");

  await seedHR(sql, ORG, 10000);
  log("HR: done");

  await seedNotifications(sql, ORG, 200);
  log("notifications: done");

  await seedChat(sql, ORG, ownerUserId, 100, 5000);
  log("chat: done");

  await seedKB(sql, ORG, ownerUserId, 10, 200);
  log("KB: done");

  await seedLeave(sql, ORG, leaveTypeIds);
  log("leave + attendance: done");

  await seedCRM(ownerUserId);
  await seedAccounting(ownerUserId);
  await seedInventory(ownerUserId);
  await seedPayroll(ownerUserId);

  await vacuumAnalyze();

  const counts = await sql`
    SELECT relname, n_live_tup::int rows, pg_size_pretty(pg_total_relation_size(relid)) size
    FROM pg_stat_user_tables
    WHERE schemaname = 'public' AND n_live_tup > 0
    ORDER BY n_live_tup DESC LIMIT 20`;
  console.table(counts.map((r) => ({ table: r.relname, rows: r.rows, size: r.size })));
}

main()
  .then(() => log("seed complete"))
  .catch((err) => {
    console.error("SEED FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
