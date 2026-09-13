/**
 * PERF1 budget seeder — seeds the org used by run-read-cost-budgets.mjs
 * so every budget can measure rather than skip.
 *
 * Run with the owner role (DATABASE_URL) to bypass RLS during load.
 * Do NOT run against NODE_ENV=production.
 *
 * Usage:
 *   SEED_ORG_ID=73e5076a-225f-4b4c-b93e-9bc66a548bfe node src/scripts/seed-perf1-budgets.mjs
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
  console.log("PASS: seed-perf1-budgets target guard, 5 cases.");
  process.exit(0);
}

dotenv.config({ path: resolve(process.cwd(), ".env") });

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run against NODE_ENV=production.");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required (owner role to bypass RLS during load).");
  process.exit(1);
}

const _perf1Guard = assertDisposableTarget(url);
if (!_perf1Guard.allowed) {
  process.stderr.write(
    `seed-perf1-budgets BLOCKED — ${_perf1Guard.reason}\n` +
    "  Set DATABASE_URL to a loopback or named scratch/test database before seeding.\n",
  );
  process.exit(1);
}

const ORG = process.env.SEED_ORG_ID;
if (!ORG) {
  console.error("SEED_ORG_ID is required.");
  process.exit(1);
}

const ssl = process.env.PGSSLMODE === "disable" ? false : "require";
const db = postgres(url, { max: 1, prepare: false, ssl, onnotice: () => {} });

const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

async function main() {
  await db`SET statement_timeout = 0`;

  // Verify org exists and fetch its active members
  const [orgRow] = await db`SELECT id FROM organizations WHERE id = ${ORG}`;
  if (!orgRow) throw new Error(`Org ${ORG} does not exist`);

  const members = await db`
    SELECT user_id FROM organization_members
    WHERE org_id = ${ORG} AND status = 'ACTIVE' ORDER BY user_id`;
  if (!members.length) throw new Error(`Org ${ORG} has no ACTIVE members`);

  const u1 = members[0].user_id;
  const u2 = (members[1] ?? members[0]).user_id;
  log(`org ${ORG} — users: ${u1}, ${u2}`);

  // ── 1. leave_types ────────────────────────────────────────────────────────
  await db`
    INSERT INTO leave_types (org_id, name, days_per_year)
    SELECT ${ORG}, name, days
    FROM (VALUES
      ('Annual Leave', 21),
      ('Sick Leave', 12),
      ('Casual Leave', 8),
      ('Unpaid Leave', 0)
    ) v(name, days)
    ON CONFLICT DO NOTHING`;
  const leaveTypes = await db`SELECT id FROM leave_types WHERE org_id = ${ORG} ORDER BY id`;
  const ltId = leaveTypes[0]?.id;
  log(`leave_types: ${leaveTypes.length}`);

  // ── 2. organization_people ────────────────────────────────────────────────
  const [opExisting] = await db`SELECT count(*)::int FROM organization_people WHERE organization_id = ${ORG}`;
  if (Number(opExisting.count) < 20) {
    await db`
      INSERT INTO organization_people (organization_person_id, organization_id, first_name, last_name, display_name)
      SELECT gen_random_uuid()::text, ${ORG}, 'Person' || g, 'Seed' || g, 'Person Seed ' || g
      FROM generate_series(1, 20) g`;
  }
  const opCount = await db`SELECT count(*)::int FROM organization_people WHERE organization_id = ${ORG}`;
  log(`organization_people: ${opCount[0].count}`);

  // ── 3. hr_people (5000 rows — powers employee-record-list rowCountSql) ─────
  const [hrpExisting] = await db`SELECT count(*)::int FROM hr_people WHERE org_id = ${ORG}`;
  if (Number(hrpExisting.count) < 5000) {
    const needed = 5000 - Number(hrpExisting.count);
    await db`INSERT INTO hr_people (org_id) SELECT ${ORG} FROM generate_series(1, ${needed})`;
  }
  const hrPeople = await db`SELECT id FROM hr_people WHERE org_id = ${ORG} ORDER BY id`;
  log(`hr_people: ${hrPeople.length}`);

  // ── 4. hr_employments (5000 rows) ─────────────────────────────────────────
  const [hreExisting] = await db`SELECT count(*)::int FROM hr_employments WHERE org_id = ${ORG} AND deleted_at IS NULL`;
  if (Number(hreExisting.count) < 5000) {
    // Only seed for hr_people that don't already have an employment
    await db`
      INSERT INTO hr_employments (org_id, person_id, employee_number)
      SELECT ${ORG}, p.id, 'EMP-' || lpad(p.rn::text, 5, '0')
      FROM (
        SELECT hp.id, row_number() OVER (ORDER BY hp.id) rn
        FROM hr_people hp
        WHERE hp.org_id = ${ORG}
          AND NOT EXISTS (SELECT 1 FROM hr_employments he WHERE he.org_id = ${ORG} AND he.person_id = hp.id)
      ) p`;
  }
  const empRows = await db`SELECT id FROM hr_employments WHERE org_id = ${ORG} AND deleted_at IS NULL ORDER BY id`;
  log(`hr_employments: ${empRows.length}`);

  // ── 5. hr_reporting_lines (1000 rows) ─────────────────────────────────────
  // Manager = the first employment of the org; skip the first (it would self-reference)
  if (empRows.length >= 2) {
    const managerId = empRows[0].id;
    const empIds = empRows.slice(1, 1001).map((r) => r.id);
    await db`
      INSERT INTO hr_reporting_lines (org_id, employment_id, manager_employment_id, created_by, effective_from)
      SELECT ${ORG}, e.id, ${managerId}, ${u1}, CURRENT_DATE - (g % 730 || ' days')::interval
      FROM unnest(${db.array(empIds)}::int[]) WITH ORDINALITY e(id, g)
      ON CONFLICT DO NOTHING`;
    const rlCount = await db`SELECT count(*)::int FROM hr_reporting_lines WHERE org_id = ${ORG}`;
    log(`hr_reporting_lines: ${rlCount[0].count}`);
  }

  // ── 6. notifications (150 rows per user) ──────────────────────────────────
  const [notifExisting] = await db`SELECT count(*)::int FROM notifications WHERE org_id = ${ORG}`;
  if (Number(notifExisting.count) < 300) {
  for (const uid of [u1, u2]) {
    await db`
      INSERT INTO notifications
        (org_id, user_id, type, priority, category, channel, title, message, is_read, pinned)
      SELECT
        ${ORG}, ${uid},
        (ARRAY['INFO','SUCCESS','WARNING','ERROR'])[1 + (g % 4)]::notification_type,
        (ARRAY['LOW','NORMAL','HIGH','CRITICAL'])[1 + (g % 4)]::notification_priority,
        (ARRAY['PROJECTS','HRMS','CRM','BILLING','CHAT'])[1 + (g % 5)]::notification_category,
        'IN_APP'::notification_channel,
        'Notification ' || g,
        'This is seeded notification body number ' || g || '.',
        (g % 3 = 0),
        false
      FROM generate_series(1, 150) g`;
  }
  }
  const notifCount = await db`SELECT count(*)::int FROM notifications WHERE org_id = ${ORG}`;
  log(`notifications: ${notifCount[0].count}`);

  // ── 7. chat_channels ──────────────────────────────────────────────────────
  const [chExisting] = await db`SELECT count(*)::int FROM chat_channels WHERE org_id = ${ORG}`;
  if (Number(chExisting.count) < 60) { await db`
    INSERT INTO chat_channels (org_id, name, type, created_by, last_message_at)
    SELECT ${ORG}, 'channel-' || g, 'PUBLIC', ${u1}, now() - (g || ' hours')::interval
    FROM generate_series(1, 60) g
    ON CONFLICT DO NOTHING`; }
  const channels = await db`SELECT id FROM chat_channels WHERE org_id = ${ORG} ORDER BY id`;
  log(`chat_channels: ${channels.length}`);

  // ── 8. chat_channel_members ───────────────────────────────────────────────
  if (channels.length) {
    await db`
      INSERT INTO chat_channel_members (channel_id, user_id, org_id, last_read_at, joined_at)
      SELECT c.id, u.uid, ${ORG}, now() - (c.rn || ' minutes')::interval, now() - (c.rn || ' days')::interval
      FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM chat_channels WHERE org_id = ${ORG}) c
      CROSS JOIN (VALUES (${u1}),(${u2})) u(uid)
      ON CONFLICT DO NOTHING`;
    log("chat_channel_members: done");
  }

  // ── 9. chat_messages ──────────────────────────────────────────────────────
  if (channels.length) {
    const chIds = channels.map((c) => c.id);
    await db`
      INSERT INTO chat_messages (org_id, channel_id, sender_id, content, message_type, created_at)
      SELECT
        ${ORG},
        c.id,
        ${u1},
        'Seeded message ' || g || ' in channel ' || c.id,
        'text'::chat_message_type,
        now() - (g || ' minutes')::interval
      FROM generate_series(1, 250) g
      JOIN lateral (
        SELECT id FROM unnest(${db.array(chIds)}::int[]) WITH ORDINALITY x(id, rn)
        WHERE x.rn = ((g - 1) % ${chIds.length}) + 1
      ) c ON true`;
    const msgRows = await db`SELECT id FROM chat_messages WHERE org_id = ${ORG} ORDER BY id LIMIT 60`;
    log(`chat_messages: ${(await db`SELECT count(*)::int FROM chat_messages WHERE org_id = ${ORG}`)[0].count}`);

    // ── 10. chat_saved_messages ───────────────────────────────────────────
    const msgIds = msgRows.map((r) => r.id);
    if (msgIds.length) {
      await db`
        INSERT INTO chat_saved_messages (org_id, user_id, message_id, saved_at)
        SELECT ${ORG}, ${u1}, m.id, now() - (m.rn || ' minutes')::interval
        FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM chat_messages WHERE org_id = ${ORG} LIMIT 60) m
        ON CONFLICT DO NOTHING`;
      log("chat_saved_messages: done");
    }
  }

  // ── 11. kb_spaces ─────────────────────────────────────────────────────────
  await db`
    INSERT INTO kb_spaces (org_id, name, slug)
    SELECT ${ORG}, 'Space ' || g, 'space-' || ${ORG.slice(0, 8)} || '-' || g
    FROM generate_series(1, 5) g
    ON CONFLICT DO NOTHING`;
  const spaces = await db`SELECT id FROM kb_spaces WHERE org_id = ${ORG} ORDER BY id`;
  log(`kb_spaces: ${spaces.length}`);

  // ── 12. kb_pages ──────────────────────────────────────────────────────────
  if (spaces.length) {
    const spIds = spaces.map((s) => s.id);
    await db`
      INSERT INTO kb_pages (org_id, space_id, title, status, visibility, sort_order, updated_at)
      SELECT
        ${ORG},
        sp.id,
        'Page ' || g || ' in Space ' || sp.id,
        'published',
        'org',
        g,
        now() - (g || ' hours')::interval
      FROM generate_series(1, 50) g
      JOIN lateral (
        SELECT id FROM unnest(${db.array(spIds)}::int[]) WITH ORDINALITY x(id, rn)
        WHERE x.rn = ((g - 1) % ${spIds.length}) + 1
      ) sp ON true`;
    const pages = await db`SELECT id FROM kb_pages WHERE org_id = ${ORG} ORDER BY id LIMIT 50`;
    log(`kb_pages: ${pages.length}`);

    // ── 13. kb_page_visits ────────────────────────────────────────────────
    if (pages.length) {
      const pgIds = pages.map((p) => p.id);
      await db`
        INSERT INTO kb_page_visits (org_id, user_id, page_id, visited_at)
        SELECT
          ${ORG}, ${u1},
          p.id,
          now() - (p.rn || ' hours')::interval
        FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM kb_pages WHERE org_id = ${ORG} LIMIT 50) p
        ON CONFLICT DO NOTHING`;
      log("kb_page_visits: done");
    }
  }

  // ── 14. leave_requests ────────────────────────────────────────────────────
  if (ltId) {
    await db`
      INSERT INTO leave_requests
        (org_id, user_id, leave_type_id, start_date, end_date, priority, status, is_half_day, lop_days)
      SELECT
        ${ORG}, u.uid, ${ltId},
        (CURRENT_DATE + (g || ' days')::interval)::date,
        (CURRENT_DATE + (g + 2 || ' days')::interval)::date,
        'NORMAL',
        (ARRAY['PENDING','APPROVED','REJECTED'])[1 + (g % 3)]::leave_status,
        false, 0
      FROM generate_series(1, 30) g
      CROSS JOIN (VALUES (${u1}),(${u2})) u(uid)
      LIMIT 30`;
    const lrCount = await db`SELECT count(*)::int FROM leave_requests WHERE org_id = ${ORG}`;
    log(`leave_requests: ${lrCount[0].count}`);

    // ── 15. leave_balances ────────────────────────────────────────────────
    await db`
      INSERT INTO leave_balances (org_id, user_id, leave_type_id, balance, year)
      SELECT ${ORG}, u.uid, lt.id, 15 - (lt.rn * 2), EXTRACT(YEAR FROM CURRENT_DATE)::int
      FROM (VALUES (${u1}),(${u2})) u(uid)
      CROSS JOIN (SELECT id, row_number() OVER (ORDER BY id) rn FROM leave_types WHERE org_id = ${ORG}) lt
      ON CONFLICT DO NOTHING`;
    log("leave_balances: done");

    // ── 16. hr_leave_ledger ───────────────────────────────────────────────
    await db`
      INSERT INTO hr_leave_ledger
        (org_id, user_id, leave_type_id, txn_type, days, effective_date, source)
      SELECT
        ${ORG}, u.uid, ${ltId},
        'accrual'::hr_leave_txn_type,
        1.75,
        (CURRENT_DATE - (g || ' months')::interval)::date,
        'cron'::hr_leave_ledger_source
      FROM generate_series(1, 10) g
      CROSS JOIN (VALUES (${u1}),(${u2})) u(uid)
      LIMIT 20`;
    log("hr_leave_ledger: done");
  }

  // ── 17. attendance ────────────────────────────────────────────────────────
  await db`
    INSERT INTO attendance (org_id, user_id, date, check_in, check_out, status)
    SELECT
      ${ORG}, u.uid,
      (CURRENT_DATE - (g || ' days')::interval)::date,
      (CURRENT_DATE - (g || ' days')::interval + '09:00:00'::interval),
      (CURRENT_DATE - (g || ' days')::interval + '18:00:00'::interval),
      'PRESENT'
    FROM generate_series(1, 20) g
    CROSS JOIN (VALUES (${u1}),(${u2})) u(uid)
    LIMIT 40
    ON CONFLICT DO NOTHING`;
  log("attendance: done");

  // ── 18. contacts ──────────────────────────────────────────────────────────
  await db`
    INSERT INTO contacts (org_id, name, email)
    SELECT ${ORG}, 'Contact ' || g, 'contact' || g || '@seed.invalid'
    FROM generate_series(1, 60) g`;
  log("contacts: done");

  // ── 19. leads ─────────────────────────────────────────────────────────────
  await db`
    INSERT INTO leads (org_id, name, email, source, status, priority, score)
    SELECT
      ${ORG},
      'Lead ' || g,
      'lead' || g || '@seed.invalid',
      'WEBSITE',
      (ARRAY['NEW','CONTACTED','QUALIFIED','PROPOSAL','NEGOTIATION'])[1 + (g % 5)],
      (ARRAY['LOW','MEDIUM','HIGH'])[1 + (g % 3)],
      (g % 100)
    FROM generate_series(1, 60) g`;
  log("leads: done");

  // ── 20. deals ─────────────────────────────────────────────────────────────
  await db`
    INSERT INTO deals (org_id, name, stage, probability, value_minor)
    SELECT
      ${ORG},
      'Deal ' || g,
      (ARRAY['DISCOVERY','PROPOSAL','NEGOTIATION','CLOSED_WON','CLOSED_LOST'])[1 + (g % 5)],
      (g % 100),
      (g * 50000)::bigint
    FROM generate_series(1, 60) g`;
  log("deals: done");

  // ── 21. clients ───────────────────────────────────────────────────────────
  await db`
    INSERT INTO clients (org_id, name, status, health_score, health_status)
    SELECT
      ${ORG},
      'Client ' || g,
      'ACTIVE',
      80 - (g % 40),
      (ARRAY['healthy','at_risk','critical'])[1 + (g % 3)]::crm_health
    FROM generate_series(1, 25) g`;
  const clients = await db`SELECT id FROM clients WHERE org_id = ${ORG} ORDER BY id LIMIT 25`;
  log(`clients: ${clients.length}`);

  // ── 22. invoices ──────────────────────────────────────────────────────────
  if (clients.length) {
    await db`
      INSERT INTO invoices
        (org_id, client_id, invoice_number, status, subtotal, tax_rate, tax_amount,
         discount, total, currency, reverse_charge, tax_inclusive, cgst_amount,
         sgst_amount, igst_amount, is_recurring, amount_paid, exchange_rate, created_by)
      SELECT
        ${ORG},
        c.id,
        'INV-' || lpad(g::text, 6, '0'),
        (ARRAY['DRAFT','SENT','OVERDUE','PARTIALLY_PAID','PAID'])[1 + (g % 5)]::invoice_status,
        (g * 1000)::numeric, 18, (g * 180)::numeric, 0,
        (g * 1180)::numeric, 'INR', false, false,
        (g * 90)::numeric, (g * 90)::numeric, 0, false,
        CASE WHEN g % 3 = 0 THEN (g * 590)::numeric ELSE 0 END,
        1.0, ${u1}
      FROM generate_series(1, 25) g
      JOIN lateral (
        SELECT id FROM clients WHERE org_id = ${ORG}
        ORDER BY id LIMIT 1 OFFSET ((g - 1) % ${clients.length})
      ) c ON true`;
    log("invoices: done");
  }

  // ── 23. purchase_bills ────────────────────────────────────────────────────
  await db`
    INSERT INTO purchase_bills (org_id, bill_number, bill_date, status, created_by)
    SELECT
      ${ORG},
      'BILL-' || lpad(g::text, 6, '0'),
      (CURRENT_DATE - (g || ' days')::interval)::date,
      (ARRAY['DRAFT','PENDING','OVERDUE','PARTIALLY_PAID'])[1 + (g % 4)],
      ${u1}
    FROM generate_series(1, 25) g`;
  log("purchase_bills: done");

  // ── 24–27. gl_books, fiscal_years, periods, journals ──────────────────────
  await db`
    INSERT INTO gl_books (id, org_id, name, country_code, base_currency, localization_pack)
    VALUES ('book-seed-' || ${ORG.slice(0, 8)}, ${ORG}, 'Seed Ledger', 'IN', 'INR', 'in')
    ON CONFLICT (id) DO NOTHING`;
  const [book] = await db`SELECT id FROM gl_books WHERE org_id = ${ORG} LIMIT 1`;
  if (book) {
    await db`
      INSERT INTO gl_fiscal_years (id, org_id, book_id, name, starts_on, ends_on)
      VALUES ('fy-seed-' || ${ORG.slice(0, 8)}, ${ORG}, ${book.id}, 'FY 2025-26', '2025-04-01', '2026-03-31')
      ON CONFLICT (id) DO NOTHING`;
    const [fy] = await db`SELECT id FROM gl_fiscal_years WHERE org_id = ${ORG} LIMIT 1`;
    if (fy) {
      await db`
        INSERT INTO gl_periods (id, org_id, book_id, fiscal_year_id, name, starts_on, ends_on, sequence)
        SELECT
          'period-' || ${ORG.slice(0, 8)} || '-' || g,
          ${ORG}, ${book.id}, ${fy.id},
          to_char(date '2025-04-01' + ((g - 1) || ' months')::interval, 'Mon YYYY'),
          (date '2025-04-01' + ((g - 1) || ' months')::interval)::date,
          (date '2025-04-30' + ((g - 1) || ' months')::interval)::date,
          g
        FROM generate_series(1, 5) g
        ON CONFLICT (id) DO NOTHING`;
      const [period] = await db`SELECT id FROM gl_periods WHERE org_id = ${ORG} LIMIT 1`;
      if (period) {
        await db`
          INSERT INTO gl_journals
            (id, org_id, book_id, period_id, journal_number, journal_date, source_type, idempotency_key)
          SELECT
            'jnl-' || ${ORG.slice(0, 8)} || '-' || g,
            ${ORG}, ${book.id}, ${period.id},
            'JNL-' || lpad(g::text, 6, '0'),
            (CURRENT_DATE - (g || ' days')::interval)::date,
            'manual'::gl_journal_source,
            'idmp-' || ${ORG.slice(0, 8)} || '-' || g
          FROM generate_series(1, 35) g
          ON CONFLICT (id) DO NOTHING`;
        log("gl_journals: done");
      }
    }
  }

  // ── 28. payroll_runs ──────────────────────────────────────────────────────
  // Use DRAFT for runs we will attach line items to (immutability guard blocks LOCKED/PAID).
  await db`
    INSERT INTO payroll_runs
      (org_id, month, status, gross_total, deduction_total, employer_cost_total,
       net_total, employee_count, exception_count)
    SELECT
      ${ORG},
      to_char(CURRENT_DATE - ((g * 30) || ' days')::interval, 'YYYY-MM'),
      'DRAFT'::payroll_run_status,
      500000, 80000, 60000, 420000, 2, 0
    FROM generate_series(1, 6) g
    ON CONFLICT DO NOTHING`;
  const runs = await db`SELECT id FROM payroll_runs WHERE org_id = ${ORG} ORDER BY id`;
  log(`payroll_runs: ${runs.length}`);

  // ── 29. payroll_run_employees ─────────────────────────────────────────────
  for (const run of runs) {
    await db`
      INSERT INTO payroll_run_employees
        (org_id, run_id, user_id, worker_type, currency, scheduled_days, paid_days, lop_days, gross, net)
      SELECT
        ${ORG}, ${run.id}, u.uid,
        'EMPLOYEE'::payroll_worker_type, 'INR',
        26, 26, 0, 250000, 210000
      FROM (VALUES (${u1}),(${u2})) u(uid)
      ON CONFLICT DO NOTHING`;
  }
  const runEmps = await db`SELECT id, run_id FROM payroll_run_employees WHERE org_id = ${ORG} ORDER BY id`;
  log(`payroll_run_employees: ${runEmps.length}`);

  // ── 30. payroll_line_items ────────────────────────────────────────────────
  for (const emp of runEmps.slice(0, 6)) {
    await db`
      INSERT INTO payroll_line_items
        (org_id, run_id, run_employee_id, code, name, category, amount, calc_method, calc_explain, taxable)
      VALUES
        (${ORG}, ${emp.run_id}, ${emp.id}, 'BASIC', 'Basic Salary', 'EARNING'::salary_component_type, 150000, 'FIXED'::salary_component_calc_method, '{}', true),
        (${ORG}, ${emp.run_id}, ${emp.id}, 'HRA', 'House Rent Allowance', 'EARNING'::salary_component_type, 60000, 'FIXED'::salary_component_calc_method, '{}', false)`;
  }
  log("payroll_line_items: done");

  // ── 31–38. Inventory ──────────────────────────────────────────────────────
  await db`
    INSERT INTO inv_warehouses (org_id, name, code, created_by)
    VALUES (${ORG}, 'Main Warehouse', 'WH-MAIN', ${u1})
    ON CONFLICT DO NOTHING`;
  const [wh] = await db`SELECT id FROM inv_warehouses WHERE org_id = ${ORG} LIMIT 1`;
  log(`inv_warehouses: ${wh ? 1 : 0}`);

  if (wh) {
    await db`
      INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
      SELECT ${ORG}, ${wh.id}, 'Zone ' || g, 'ZONE-' || g, 'ZONE'::inv_location_type
      FROM generate_series(1, 3) g
      ON CONFLICT DO NOTHING`;
  }
  const [loc] = await db`SELECT id FROM inv_locations WHERE org_id = ${ORG} LIMIT 1`;
  log(`inv_locations: ${loc ? "ok" : "NONE"}`);

  await db`
    INSERT INTO inv_vendors (org_id, name, code, created_by)
    SELECT ${ORG}, 'Vendor ' || g, 'VEN-' || lpad(g::text, 3, '0'), ${u1}
    FROM generate_series(1, 15) g
    ON CONFLICT DO NOTHING`;
  const [vendor] = await db`SELECT id FROM inv_vendors WHERE org_id = ${ORG} LIMIT 1`;
  log("inv_vendors: done");

  await db`
    INSERT INTO inv_products (org_id, name, sku, created_by)
    SELECT ${ORG}, 'Product ' || g, 'SKU-' || lpad(g::text, 5, '0'), ${u1}
    FROM generate_series(1, 60) g
    ON CONFLICT DO NOTHING`;
  const products = await db`SELECT id FROM inv_products WHERE org_id = ${ORG} ORDER BY id`;
  log(`inv_products: ${products.length}`);

  // One variant per product
  for (const prod of products) {
    await db`
      INSERT INTO inv_product_variants
        (org_id, product_id, name, sku, cost_price, selling_price, attribute_values, is_active)
      VALUES
        (${ORG}, ${prod.id}, 'Default', 'SKU-V-' || ${prod.id}, 100, 150, '{}', true)
      ON CONFLICT DO NOTHING`;
  }
  const variants = await db`SELECT id FROM inv_product_variants WHERE org_id = ${ORG} ORDER BY id`;
  log(`inv_product_variants: ${variants.length}`);

  if (loc && variants.length) {
    await db`
      INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_hand)
      SELECT ${ORG}, v.id, ${loc.id}, 100
      FROM inv_product_variants v WHERE v.org_id = ${ORG}
      ON CONFLICT DO NOTHING`;
    log("inv_stock_levels: done");

    // Stock transactions
    await db`
      INSERT INTO inv_stock_transactions
        (org_id, product_variant_id, transaction_type, quantity_change, quantity_before, quantity_after, posting_date, created_by)
      SELECT
        ${ORG}, v.id, 'GRN', 100, 0, 100, CURRENT_DATE - (g % 90 || ' days')::interval, ${u1}
      FROM inv_product_variants v
      CROSS JOIN generate_series(1, 2) g
      WHERE v.org_id = ${ORG}
      LIMIT 110`;
    log("inv_stock_transactions: done");
  }

  if (vendor) {
    await db`
      INSERT INTO inv_purchase_orders (org_id, vendor_id, po_number, order_date, created_by)
      SELECT
        ${ORG}, ${vendor.id},
        'PO-' || lpad(g::text, 6, '0'),
        (CURRENT_DATE - (g || ' days')::interval)::date,
        ${u1}
      FROM generate_series(1, 25) g
      ON CONFLICT DO NOTHING`;
    log("inv_purchase_orders: done");
  }

  // ── 39. support_tickets ────────────────────────────────────────────────────
  await db`
    INSERT INTO support_tickets
      (org_id, title, status, priority, created_by, source_channel,
       sla_paused_minutes, sla_escalation_level)
    SELECT
      ${ORG},
      'Support Ticket ' || g,
      (ARRAY['OPEN','IN_PROGRESS','WAITING','RESOLVED'])[1 + (g % 4)]::support_ticket_status,
      (ARRAY['LOW','MEDIUM','HIGH','URGENT'])[1 + (g % 4)]::support_ticket_priority,
      ${u1}, 'EMAIL', 0, 0
    FROM generate_series(1, 60) g`;
  log("support_tickets: done");

  // ── 40. VACUUM ANALYZE ─────────────────────────────────────────────────────
  const tables = [
    "notifications", "chat_channels", "chat_channel_members", "chat_messages",
    "chat_saved_messages", "kb_spaces", "kb_pages", "kb_page_visits",
    "organization_people", "hr_people", "hr_employments", "hr_reporting_lines",
    "leave_types", "leave_requests", "leave_balances", "hr_leave_ledger", "attendance",
    "contacts", "leads", "deals", "clients", "invoices", "purchase_bills",
    "gl_books", "gl_fiscal_years", "gl_periods", "gl_journals",
    "payroll_runs", "payroll_run_employees", "payroll_line_items",
    "inv_warehouses", "inv_locations", "inv_vendors", "inv_products",
    "inv_product_variants", "inv_stock_levels", "inv_stock_transactions",
    "inv_purchase_orders", "support_tickets",
  ];
  for (const t of tables) {
    try {
      await db.unsafe(`VACUUM ANALYZE ${t}`);
    } catch (_) {
      // table may be in a different schema or not exist in all envs
    }
  }
  await db.unsafe("VACUUM ANALYZE build.tickets");
  await db.unsafe("VACUUM ANALYZE build.ticket_assignees");
  log("VACUUM ANALYZE: done");

  log("seed complete");
}

main()
  .catch((e) => {
    console.error("SEED FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.end());
