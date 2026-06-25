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

const created = { surveyIds: [] };

async function main() {
  const [orgRow] = await sql`SELECT org_id, count(*)::int AS n FROM leads WHERE deleted_at IS NULL GROUP BY org_id ORDER BY n DESC LIMIT 1`;
  let orgId = orgRow?.org_id;
  if (!orgId) { const [o] = await sql`SELECT id FROM organizations LIMIT 1`; orgId = o?.id; }
  if (!orgId) { rec("discover org", false, "no org"); return; }
  const [m] = await sql`SELECT user_id FROM organization_members WHERE org_id = ${orgId} LIMIT 1`;
  const sub = m?.user_id ?? "functest-user";
  rec("discover org/member", true, `org=${orgId}`);

  const owner = await mintOwner(orgId, sub);
  let r;

  r = await req("GET", "/health/ready");
  rec("GET /health/ready -> ready", r.status === 200 && r.json?.status === "ready", `status=${r.status}`);

  r = await req("GET", "/csat");
  rec("GET /csat no token -> 401", r.status === 401 && r.json?.error === "Unauthorized", `status=${r.status}`);

  r = await req("GET", "/csat", { token: owner });
  rec("GET /csat owner -> 200", r.status === 200 && r.json !== null, `status=${r.status}`);

  r = await req("POST", "/csat", { token: owner, body: {} });
  rec("POST /csat empty -> 400 validation", r.status === 400, `status=${r.status} body=${JSON.stringify(r.json)}`);

  let surveyId = null;
  r = await req("POST", "/csat", { token: owner, body: { title: "ZZ_FUNCTEST_survey", question: "How was it?", scaleMax: 5 } });
  if (r.status === 201 && typeof r.json?.id === "number") { surveyId = r.json.id; created.surveyIds.push(surveyId); }
  rec("POST /csat create -> 201", r.status === 201 && typeof r.json?.id === "number", `status=${r.status} id=${r.json?.id}`);

  r = await req("GET", "/csat/999999999", { token: owner });
  rec("GET /csat/:id missing -> 404", r.status === 404, `status=${r.status} body=${JSON.stringify(r.json)}`);

  r = await req("GET", "/csat/not-a-number", { token: owner });
  rec("GET /csat/not-a-number -> 400", r.status === 400, `status=${r.status}`);

  if (surveyId) {
    r = await req("GET", `/csat/${surveyId}`, { token: owner });
    rec("GET created survey -> 200 matches", r.status === 200 && r.json?.title === "ZZ_FUNCTEST_survey", `status=${r.status}`);

    r = await req("PATCH", `/csat/${surveyId}`, { token: owner, body: { status: "sent" } });
    rec("PATCH survey -> 200", r.status === 200, `status=${r.status}`);

    r = await req("GET", `/csat/${surveyId}/responses`, { token: owner });
    rec("GET /csat/:id/responses -> 200 array", r.status === 200 && Array.isArray(r.json), `status=${r.status}`);

    r = await req("POST", `/csat/${surveyId}/responses`, { body: { rating: 5, comment: "great", respondentName: "Tester" } });
    rec("POST public response (no token) -> 201", r.status === 201, `status=${r.status} body=${JSON.stringify(r.json)}`);

    r = await req("POST", `/csat/${surveyId}/responses`, { body: { rating: 99 } });
    rec("POST public response invalid rating -> 400", r.status === 400, `status=${r.status} body=${JSON.stringify(r.json)}`);

    r = await req("DELETE", `/csat/${surveyId}`, { token: owner });
    if (r.status >= 200 && r.status < 300) created.surveyIds = created.surveyIds.filter((id) => id !== surveyId);
    rec("DELETE survey -> 2xx (cleanup)", r.status >= 200 && r.status < 300, `status=${r.status}`);
  }
}

main()
  .catch((e) => {
    console.error("FATAL", e);
    rec("run", false, String(e?.message ?? e));
  })
  .finally(async () => {
    try {
      if (created.surveyIds.length) {
        await sql`DELETE FROM csat_responses WHERE survey_id IN ${sql(created.surveyIds)}`;
        await sql`DELETE FROM csat_surveys WHERE id IN ${sql(created.surveyIds)}`;
      }
    } catch (e) {
      console.error("cleanup csat failed:", e.message);
    }
    await sql.end({ timeout: 5 });
    const passed = results.filter((x) => x.pass).length;
    console.log(`\n=== ${passed}/${results.length} passed ===`);
    process.exit(passed === results.length ? 0 : 1);
  });
