#!/usr/bin/env node
/**
 * Captures EXPLAIN (ANALYZE, BUFFERS) for the named heavy read paths as the APPLICATION role
 * with the tenant GUC set, inside transactions that are rolled back.
 *
 * Measuring as the owner is not a weaker measurement, it is a different one: the owner carries
 * BYPASSRLS, so its plans omit the `org_id = app.current_org_id()` qual that decides whether an
 * index is usable at all. The runner refuses to start unless the connecting role has
 * rolbypassrls = false, and it proves RLS is live by checking that one query fails 42501 with no
 * GUC before it trusts any number.
 *
 * Usage:
 *   PERF_APP_DATABASE_URL=<streamline_app url> node test/perf/measure-heavy-query-plans.mjs \
 *     [--org=large|mid|small] [--ids=a,b] [--category=reminder] [--out=<dir>]
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";
import { QUERIES } from "./heavy-query-catalog.mjs";
import { summarize, selfTest as planSelfTest } from "./heavy-query-plan-analysis.mjs";
import { ORG_PROFILES, assertScratchTarget } from "./heavy-query-fixtures.mjs";

dotenv.config({ path: resolve(process.cwd(), ".env") });

if (process.argv.includes("--self-test")) {
  const ok = planSelfTest();
  const ids = QUERIES.map((q) => q.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  const missingSql = QUERIES.filter((q) => typeof q.sql !== "string" || !q.sql.trim()).map((q) => q.id);
  const missingParams = QUERIES.filter((q) => typeof q.params !== "function").map((q) => q.id);
  const catalogOk = dupes.length === 0 && missingSql.length === 0 && missingParams.length === 0;
  if (dupes.length) console.error(`  [FAIL] duplicate query ids: ${dupes.join(", ")}`);
  else console.log("  [pass] query ids are unique");
  if (missingSql.length) console.error(`  [FAIL] queries with no sql: ${missingSql.join(", ")}`);
  else console.log("  [pass] every query has sql");
  if (missingParams.length) console.error(`  [FAIL] queries with no params fn: ${missingParams.join(", ")}`);
  else console.log("  [pass] every query has a params function");
  console.log(ok && catalogOk ? "\nSELF-TEST PASSED" : "\nSELF-TEST FAILED");
  process.exit(ok && catalogOk ? 0 : 1);
}

const url = process.env.PERF_APP_DATABASE_URL || process.env.APP_DATABASE_URL;
if (!url) {
  console.error("PERF_APP_DATABASE_URL is required — it must be the non-BYPASSRLS application role.");
  process.exit(1);
}
const target = assertScratchTarget(url, [process.env.DATABASE_URL]);
if (!target.ok) {
  console.error(`measure-heavy-query-plans: ${target.reason}`);
  process.exit(1);
}

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const orgLabel = arg("org", "large");
const profile = ORG_PROFILES.find((p) => p.label === orgLabel);
if (!profile) {
  console.error(`--org must be one of ${ORG_PROFILES.map((p) => p.label).join(", ")}`);
  process.exit(1);
}
const idFilter = arg("ids") ? new Set(arg("ids").split(",").filter(Boolean)) : null;
const categoryFilter = arg("category");
const outDir = arg("out");

const ssl = url.includes("sslmode=disable") ? false : "require";
const sql = postgres(url, { max: 1, prepare: false, ssl, onnotice: () => {} });

const ORG = profile.id;

/** Everything runs here: GUC set LOCAL, work done, transaction rolled back. */
async function inTenantTx(fn) {
  let out;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.organization_id', ${ORG}, true)`;
      out = await fn(tx);
      throw new RollbackSignal();
    });
  } catch (e) {
    if (!(e instanceof RollbackSignal) && !(e?.cause instanceof RollbackSignal)) throw e;
  }
  return out;
}
class RollbackSignal extends Error {}

async function assertMeasuringUnderRls() {
  const [role] = await sql`
    SELECT current_user AS name, r.rolbypassrls, r.rolsuper
    FROM pg_roles r WHERE r.rolname = current_user`;
  if (role.rolbypassrls || role.rolsuper) {
    console.error(
      `REFUSING TO MEASURE: connected as "${role.name}" (bypassrls=${role.rolbypassrls} superuser=${role.rolsuper}).` +
        " Every plan taken this way omits the RLS qual and is worthless.",
    );
    process.exit(1);
  }

  let deniedWithoutGuc = false;
  try {
    await sql`SELECT count(*) FROM calendar_events`;
  } catch (e) {
    if (e?.code === "42501") deniedWithoutGuc = true;
    else throw e;
  }
  if (!deniedWithoutGuc) {
    console.error(
      "REFUSING TO MEASURE: calendar_events answered with no tenant GUC set." +
        " RLS is not in force on this target, so nothing measured here would carry the tenant predicate.",
    );
    process.exit(1);
  }
  console.log(
    `role ${role.name} · bypassrls=false · no-GUC read denied 42501 · database ${target.database}`,
  );
}

/** A 1536-dimension literal echoed into a plan is 20 kB of noise per occurrence. */
function elideVectorLiterals(text) {
  return text.replace(/'\[-?[\d.,\-e]{200,}\]'/g, "'[vector literal elided]'");
}

function randomUnitVector(dim) {
  const parts = new Array(dim);
  for (let i = 0; i < dim; i++) parts[i] = (Math.random() * 2 - 1).toFixed(6);
  return `[${parts.join(",")}]`;
}

async function resolveFixtures() {
  const now = new Date();
  const dueBy = new Date(now.getTime() + 20 * 60 * 1000);
  const rangeFrom = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const rangeTo = new Date(now.getTime() + 60 * 24 * 3600 * 1000);
  const busyFrom = now;
  const busyTo = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);

  return inTenantTx(async (tx) => {
    // Pick the member who actually has unread rows: a member with none turns every unread
    // measurement into the empty case, which is not the case anyone waits on.
    const [member] = await tx.unsafe(
      `SELECT m.id, m.user_id,
              count(n.id) FILTER (WHERE n.is_read = false
                                    AND n.deleted_at IS NULL
                                    AND n.archived_at IS NULL)::int AS unread,
              count(n.id)::int AS notifications
       FROM organization_members m
       LEFT JOIN notifications n ON n.org_id = m.org_id AND n.membership_id = m.id
       WHERE m.org_id = $1 AND m.status = 'ACTIVE'
       GROUP BY m.id, m.user_id
       ORDER BY 3 DESC, 4 DESC LIMIT 1`,
      [ORG],
    );
    const [wm] = await tx.unsafe(
      `SELECT last_read_notification_id FROM notification_read_watermarks
       WHERE org_id = $1 AND membership_id = $2`,
      [ORG, member?.id ?? 0],
    );
    const recurring = await tx.unsafe(
      `SELECT id FROM calendar_events WHERE org_id = $1 AND rrule IS NOT NULL ORDER BY id LIMIT 200`,
      [ORG],
    );
    const due = await tx.unsafe(
      `SELECT id FROM calendar_events
       WHERE org_id = $1 AND reminder_15min_sent = false AND all_day = false AND rrule IS NULL
         AND start_date >= now() AND start_date <= now() + interval '20 minutes'
       ORDER BY id LIMIT 200`,
      [ORG],
    );
    // The seeded 20-minute reminder window expires in wall-clock time; without a fallback the
    // fan-out page silently skips and the category reports nothing.
    const dueEvents = due.length > 0
      ? due
      : await tx.unsafe(
          `SELECT id FROM calendar_events WHERE org_id = $1 ORDER BY id DESC LIMIT 200`,
          [ORG],
        );
    const roles = await tx.unsafe(
      `SELECT id FROM roles WHERE org_id = $1 AND slug LIKE 'PERF_%' ORDER BY id LIMIT 3`,
      [ORG],
    );
    const attendees = await tx.unsafe(
      `SELECT user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 25`,
      [ORG],
    );
    const [kbPage] = await tx.unsafe(
      `SELECT title FROM kb_pages WHERE org_id = $1 AND deleted_at IS NULL AND title LIKE 'Perf Page %'
       ORDER BY id DESC LIMIT 1`,
      [ORG],
    );
    const [ticket] = await tx.unsafe(
      `SELECT title FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL
       ORDER BY id DESC LIMIT 1`,
      [ORG],
    );
    const projects = await tx.unsafe(
      `SELECT id FROM build.projects WHERE org_id = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 200`,
      [ORG],
    );
    return {
      orgId: ORG,
      membershipId: member?.id ?? 0,
      userId: member?.user_id ?? null,
      watermarkId: Number(wm?.last_read_notification_id ?? 0),
      unreadForMember: Number(member?.unread ?? 0),
      recurringIds: recurring.map((r) => r.id),
      dueEventIds: dueEvents.map((r) => r.id),
      roleIds: roles.map((r) => r.id),
      attendeeUserIds: attendees.map((r) => r.user_id),
      projectIds: projects.map((r) => r.id),
      now,
      dueBy,
      rangeFrom,
      rangeTo,
      busyFrom,
      busyTo,
      busyFromDate: iso(busyFrom),
      busyToDate: iso(busyTo),
      queryVector: randomUnitVector(1536),
      searchTerm: kbPage?.title ?? "perf page",
      ticketTerm: ticket?.title ?? "Ticket",
      ticketTermLike: `%${ticket?.title ?? "Ticket"}%`,
      searchTermLike: `%${kbPage?.title ?? "Perf Page"}%`,
    };
  });
}

async function measure(query, fixtures) {
  const params = query.params(fixtures);
  if (params.some((p) => Array.isArray(p) && p.length === 0))
    return { status: "skip", reason: "an array parameter resolved empty — no fixture data" };

  try {
    return await inTenantTx(async (tx) => {
      const runs = [];
      for (let i = 0; i < 2; i++) {
        const rows = await tx.unsafe(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
          params,
        );
        const doc = rows[0]["QUERY PLAN"][0];
        const s = summarize(doc.Plan);
        s.planningMs = doc["Planning Time"] ?? null;
        s.executionMs = doc["Execution Time"] ?? null;
        runs.push(s);
      }
      const text = await tx.unsafe(
        `EXPLAIN (ANALYZE, BUFFERS, VERBOSE) ${query.sql}`,
        params,
      );
      return {
        status: "measured",
        cold: runs[0],
        warm: runs[1],
        planText: elideVectorLiterals(text.map((r) => r["QUERY PLAN"]).join("\n")),
      };
    });
  } catch (e) {
    return { status: "error", reason: `${e?.code ?? ""} ${e?.message ?? e}`.trim() };
  }
}

async function main() {
  await assertMeasuringUnderRls();

  const fixtures = await resolveFixtures();
  console.log(
    `org ${orgLabel} (${ORG.slice(0, 8)}) · membership ${fixtures.membershipId}` +
      ` · unread ${fixtures.unreadForMember} · watermark ${fixtures.watermarkId} · recurring ${fixtures.recurringIds.length}` +
      ` · fanout-events ${fixtures.dueEventIds.length} · roles ${fixtures.roleIds.length}`,
  );

  const selected = QUERIES.filter(
    (q) => (!idFilter || idFilter.has(q.id)) && (!categoryFilter || q.category === categoryFilter),
  );
  console.log(`\nMeasuring ${selected.length} queries…\n`);

  const results = [];
  let lastCategory = null;
  for (const query of selected) {
    if (query.category !== lastCategory) {
      console.log(`── ${query.category}`);
      lastCategory = query.category;
    }
    const r = await measure(query, fixtures);
    results.push({ id: query.id, category: query.category, note: query.note ?? null, ...r });

    if (r.status !== "measured") {
      console.log(`  ${r.status.toUpperCase().padEnd(5)} ${query.id.padEnd(38)} ${r.reason}`);
      continue;
    }
    const c = r.cold;
    const d = c.dominant;
    console.log(
      `  ${query.id.padEnd(38)}` +
        ` buf=${String(c.buffers).padStart(7)} (hit ${c.sharedHit}/read ${c.sharedRead})` +
        ` rows ${c.rowsRead}→${c.rowsReturned}` +
        (c.temp.written ? ` temp=${c.temp.written}` : "") +
        `  ${d.type}${d.relation ? ` on ${d.relation}` : ""}${d.index ? ` via ${d.index}` : ""}` +
        ` [${d.exclusive} buf, -${d.removedByFilter} filtered]`,
    );
  }

  const grouped = new Map();
  for (const q of QUERIES) {
    if (!q.compare) continue;
    const r = results.find((x) => x.id === q.id);
    if (!r || r.status !== "measured") continue;
    grouped.set(q.compare, [...(grouped.get(q.compare) ?? []), r]);
  }
  if (grouped.size > 0) {
    console.log("\n── head-to-head (buffers decide, not opinion)");
    for (const [tag, rs] of grouped) {
      const best = rs.reduce((a, b) => (a.cold.buffers <= b.cold.buffers ? a : b));
      console.log(`  ${tag}:`);
      for (const r of rs)
        console.log(
          `    ${r.id === best.id ? "WIN " : "    "}${r.id.padEnd(38)} ${r.cold.buffers} buffers, ${r.cold.rowsRead} rows read`,
        );
    }
  }

  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      resolve(outDir, `plans-${orgLabel}.json`),
      JSON.stringify({ org: orgLabel, orgId: ORG, capturedAt: new Date().toISOString(), results }, null, 2),
    );
    writeFileSync(
      resolve(outDir, `plans-${orgLabel}.txt`),
      results
        .filter((r) => r.status === "measured")
        .map((r) => `### ${r.id}  (${r.category})\n${r.planText}\n`)
        .join("\n"),
    );
    console.log(`\nPlans written to ${outDir}`);
  }

  const errors = results.filter((r) => r.status === "error");
  if (errors.length > 0) {
    console.error(`\n${errors.length} query(ies) errored:`);
    for (const e of errors) console.error(`  ${e.id}: ${e.reason}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    await sql.end();
    console.error("MEASURE FAILED:", e instanceof Error ? e.stack : e);
    process.exitCode = 1;
  });
