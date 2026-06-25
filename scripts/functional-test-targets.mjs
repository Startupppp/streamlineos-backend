import postgres from "postgres";
import { SignJWT } from "jose";

const API = process.env.API_BASE || "http://localhost:1500";
const SECRET = process.env.BACKEND_JWT_SECRET;
const RAW_DB = process.env.DATABASE_URL || process.env.DB;
if (!SECRET || !RAW_DB) {
  console.error("Missing BACKEND_JWT_SECRET or DATABASE_URL in env");
  process.exit(2);
}

function normalize(url) {
  if (!/\.neon\.tech/i.test(url)) return url;
  try {
    const u = new URL(url);
    u.searchParams.delete("channel_binding");
    return u.toString();
  } catch {
    return url.replace(/[&?]channel_binding=[^&]*/g, "").replace(/\?&/, "?");
  }
}

const isNeon = /\.neon\.tech/i.test(RAW_DB);
const sql = postgres(normalize(RAW_DB), { prepare: false, max: 3, ...(isNeon ? { ssl: "require" } : {}) });
const enc = new TextEncoder().encode(SECRET);
const testStart = new Date().toISOString();

async function mintOwner(orgId, sub) {
  return new SignJWT({ orgId, branchId: null, role: "OWNER", permissions: [], enabledModules: [], plan: "ENTERPRISE", isPlatformAdmin: false, isOrgOwner: true, sessionId: "functest" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(enc);
}

const results = [];
function rec(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
}

async function req(method, path, opts = {}) {
  const headers = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

const created = { targetIds: [] };
let testUserId = null;

async function main() {
  const [orgRow] = await sql`SELECT org_id, count(*)::int AS n FROM leads WHERE deleted_at IS NULL GROUP BY org_id ORDER BY n DESC LIMIT 1`;
  let orgId = orgRow?.org_id;
  if (!orgId) { const [o] = await sql`SELECT id FROM organizations LIMIT 1`; orgId = o?.id; }
  if (!orgId) { rec("discover org", false, "no org"); return; }
  const [m] = await sql`SELECT user_id FROM organization_members WHERE org_id = ${orgId} LIMIT 1`;
  testUserId = m?.user_id ?? null;
  if (!testUserId) { rec("discover member", false, "no member in org"); return; }
  rec("discover org/member", true, `org=${orgId} user=${testUserId}`);

  const owner = await mintOwner(orgId, testUserId);
  let r;

  r = await req("GET", "/health/ready");
  rec("GET /health/ready -> ready", r.status === 200 && r.json?.status === "ready", `status=${r.status}`);

  r = await req("GET", "/targets");
  rec("GET /targets no token -> 401", r.status === 401 && r.json?.error === "Unauthorized", `status=${r.status}`);

  r = await req("GET", "/targets", { token: owner });
  rec("GET /targets owner -> 200 array", r.status === 200 && Array.isArray(r.json), `status=${r.status} isArray=${Array.isArray(r.json)}`);

  r = await req("GET", "/targets/my", { token: owner });
  rec("GET /targets/my -> 200 array", r.status === 200 && Array.isArray(r.json), `status=${r.status}`);

  r = await req("GET", "/targets/leaderboard", { token: owner });
  rec("GET /targets/leaderboard -> 200 array", r.status === 200 && Array.isArray(r.json), `status=${r.status}`);

  r = await req("GET", "/targets?limit=500", { token: owner });
  rec("GET /targets limit=500 -> 400 validation", r.status === 400, `status=${r.status} body=${JSON.stringify(r.json)}`);

  r = await req("POST", "/targets", { token: owner, body: {} });
  rec("POST /targets empty -> 400 validation", r.status === 400, `status=${r.status} body=${JSON.stringify(r.json)}`);

  let newId = null;
  r = await req("POST", "/targets", { token: owner, body: { metricType: "deals_closed", targetValue: "5", period: "monthly", startDate: "2026-06-01", endDate: "2026-06-30", userIds: [testUserId] } });
  const createdRows = Array.isArray(r.json) ? r.json : null;
  if (r.status === 201 && createdRows && createdRows[0]?.id) {
    for (const row of createdRows) created.targetIds.push(row.id);
    newId = createdRows[0].id;
  }
  rec("POST /targets create -> 201 array", r.status === 201 && !!newId, `status=${r.status} created=${createdRows?.length}`);

  if (newId) {
    r = await req("GET", "/targets", { token: owner });
    rec("created target appears in list", r.status === 200 && Array.isArray(r.json) && r.json.some((t) => t.id === newId), `status=${r.status}`);

    r = await req("PATCH", `/targets/${newId}`, { token: owner, body: { targetValue: "8" } });
    rec("PATCH target -> 200", r.status === 200, `status=${r.status}`);

    r = await req("GET", `/targets/${newId}/history`, { token: owner });
    rec("GET /targets/:id/history -> 200 array", r.status === 200 && Array.isArray(r.json), `status=${r.status} rows=${Array.isArray(r.json) ? r.json.length : "n/a"}`);

    r = await req("DELETE", `/targets/${newId}`, { token: owner });
    if (r.status >= 200 && r.status < 300) created.targetIds = created.targetIds.filter((id) => id !== newId);
    rec("DELETE target -> 2xx {success}", r.status >= 200 && r.status < 300 && r.json?.success === true, `status=${r.status} body=${JSON.stringify(r.json)}`);
  }
}

main()
  .catch((e) => {
    console.error("FATAL", e);
    rec("run", false, String(e?.message ?? e));
  })
  .finally(async () => {
    try {
      if (created.targetIds.length) {
        await sql`DELETE FROM target_history WHERE target_id IN ${sql(created.targetIds)}`;
        await sql`DELETE FROM targets WHERE id IN ${sql(created.targetIds)}`;
      }
    } catch (e) {
      console.error("cleanup targets failed:", e.message);
    }
    try {
      if (testUserId) {
        await sql`DELETE FROM notifications WHERE user_id = ${testUserId} AND created_at >= ${testStart} AND title ILIKE '%target%'`;
      }
    } catch (e) {
      console.error("cleanup notifications failed:", e.message);
    }
    await sql.end({ timeout: 5 });
    const passed = results.filter((x) => x.pass).length;
    console.log(`\n=== ${passed}/${results.length} passed ===`);
    process.exit(passed === results.length ? 0 : 1);
  });
