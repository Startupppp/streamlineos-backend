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
  return new SignJWT({
    orgId,
    branchId: null,
    role: "OWNER",
    permissions: [],
    enabledModules: [],
    plan: "ENTERPRISE",
    isPlatformAdmin: false,
    isOrgOwner: true,
    sessionId: "functest",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(enc);
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
  const ct = res.headers.get("content-type") || "";
  let json = null;
  let text = null;
  if (ct.includes("application/json")) {
    try { json = await res.json(); } catch { json = null; }
  } else {
    try { text = await res.text(); } catch { text = null; }
  }
  return { status: res.status, json, text, ct };
}

const created = { contactIds: [] };

async function main() {
  const [orgRow] = await sql`SELECT org_id, count(*)::int AS n FROM contacts GROUP BY org_id ORDER BY n DESC LIMIT 1`;
  let orgId = orgRow?.org_id;
  let existingCount = orgRow?.n ?? 0;
  if (!orgId) {
    const [anyOrg] = await sql`SELECT id FROM organizations LIMIT 1`;
    orgId = anyOrg?.id;
  }
  if (!orgId) { rec("discover org", false, "no organization found"); return; }
  const [memberRow] = await sql`SELECT user_id FROM organization_members WHERE org_id = ${orgId} LIMIT 1`;
  const sub = memberRow?.user_id ?? "functest-user";
  const [contactRow] = await sql`SELECT id FROM contacts WHERE org_id = ${orgId} LIMIT 1`;
  const sampleId = contactRow?.id ?? null;
  rec("discover org/member/contact", true, `org=${orgId} contacts=${existingCount} sample=${sampleId}`);

  const owner = await mintOwner(orgId, sub);

  let r;
  r = await req("GET", "/health/ready");
  rec("GET /health/ready -> ready", r.status === 200 && r.json?.status === "ready", `status=${r.status}`);

  r = await req("GET", "/contacts");
  rec("GET /contacts no token -> 401", r.status === 401 && r.json?.error === "Unauthorized", `status=${r.status}`);

  r = await req("GET", "/contacts?limit=5", { token: owner });
  rec("GET /contacts owner -> 200 {items,total}", r.status === 200 && Array.isArray(r.json?.items) && typeof r.json?.total === "number", `status=${r.status} items=${r.json?.items?.length} total=${r.json?.total}`);

  r = await req("GET", "/contacts?limit=500", { token: owner });
  rec("GET /contacts limit=500 -> 400 validation", r.status === 400, `status=${r.status} body=${JSON.stringify(r.json)}`);

  r = await req("GET", "/contacts/search?q=ab", { token: owner });
  rec("GET /contacts/search (q>=2) -> 200", r.status === 200, `status=${r.status}`);

  r = await req("GET", "/contacts/search?q=a", { token: owner });
  rec("GET /contacts/search q too short -> 400", r.status === 400, `status=${r.status} body=${JSON.stringify(r.json)}`);

  r = await req("GET", "/contacts/999999999", { token: owner });
  rec("GET /contacts/:id missing -> 404", r.status === 404, `status=${r.status} body=${JSON.stringify(r.json)}`);

  r = await req("GET", "/contacts/not-a-number", { token: owner });
  rec("GET /contacts/not-a-number -> 400", r.status === 400, `status=${r.status}`);

  r = await req("POST", "/contacts", { token: owner, body: {} });
  rec("POST /contacts empty -> 400 validation", r.status === 400, `status=${r.status} body=${JSON.stringify(r.json)}`);

  let newId = null;
  r = await req("POST", "/contacts", { token: owner, body: { name: "ZZ_FUNCTEST_contact", email: "ct@example.com", company: "ZZ Co" } });
  if (r.status === 201 && typeof r.json?.id === "number") { newId = r.json.id; created.contactIds.push(newId); }
  rec("POST /contacts create -> 201", r.status === 201 && typeof r.json?.id === "number", `status=${r.status} id=${r.json?.id}`);

  if (newId) {
    r = await req("GET", `/contacts/${newId}`, { token: owner });
    rec("GET created contact -> 200 matches", r.status === 200 && r.json?.name === "ZZ_FUNCTEST_contact", `status=${r.status}`);

    r = await req("PATCH", `/contacts/${newId}`, { token: owner, body: { title: "Updated by functest" } });
    rec("PATCH contact -> 200", r.status === 200, `status=${r.status}`);

    r = await req("GET", `/contacts/${newId}/vcard`, { token: owner });
    rec("GET /contacts/:id/vcard -> 200 vCard", r.status === 200 && /text\/vcard/.test(r.ct) && /BEGIN:VCARD/.test(r.text ?? ""), `status=${r.status} ct=${r.ct}`);

    r = await req("DELETE", `/contacts/${newId}`, { token: owner });
    if (r.status >= 200 && r.status < 300) created.contactIds = created.contactIds.filter((id) => id !== newId);
    rec("DELETE contact -> 2xx (cleanup)", r.status >= 200 && r.status < 300, `status=${r.status}`);
  }
}

main()
  .catch((e) => {
    console.error("FATAL", e);
    rec("run", false, String(e?.message ?? e));
  })
  .finally(async () => {
    try {
      if (created.contactIds.length) await sql`DELETE FROM contacts WHERE id IN ${sql(created.contactIds)}`;
    } catch (e) {
      console.error("cleanup contacts failed:", e.message);
    }
    await sql.end({ timeout: 5 });
    const passed = results.filter((x) => x.pass).length;
    console.log(`\n=== ${passed}/${results.length} passed ===`);
    process.exit(passed === results.length ? 0 : 1);
  });
