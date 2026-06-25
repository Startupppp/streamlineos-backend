import postgres from "postgres";
import { SignJWT } from "jose";
import { createHash } from "crypto";

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

async function mint(claims) {
  return new SignJWT({
    orgId: claims.orgId,
    branchId: claims.branchId ?? null,
    role: claims.role ?? "SALES",
    permissions: claims.permissions ?? [],
    enabledModules: claims.enabledModules ?? [],
    plan: claims.plan ?? "ENTERPRISE",
    isPlatformAdmin: !!claims.isPlatformAdmin,
    isOrgOwner: !!claims.isOrgOwner,
    sessionId: "functest",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
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
  if (opts.apiKey) headers["X-API-Key"] = opts.apiKey;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const created = { leadIds: [], apiKeyIds: [] };

async function main() {
  const [orgRow] = await sql`
    SELECT org_id, count(*)::int AS n FROM leads WHERE deleted_at IS NULL
    GROUP BY org_id ORDER BY n DESC LIMIT 1`;
  if (!orgRow) {
    rec("discover org with leads", false, "no org has leads — cannot run data-path tests");
    return;
  }
  const orgId = orgRow.org_id;
  const [memberRow] = await sql`SELECT user_id FROM organization_members WHERE org_id = ${orgId} LIMIT 1`;
  const realUserId = memberRow?.user_id ?? null;
  const userId = realUserId ?? "functest-user";
  const [leadRow] = await sql`SELECT id FROM leads WHERE org_id = ${orgId} AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`;
  const sampleLeadId = leadRow?.id ?? null;
  rec("discover org/member/lead", true, `org=${orgId} leads=${orgRow.n} member=${realUserId ? "yes" : "no"} sampleLead=${sampleLeadId}`);

  const owner = await mint({ sub: userId, orgId, role: "OWNER", isOrgOwner: true });
  const sales = await mint({ sub: userId, orgId, role: "SALES", permissions: ["crm:leads:read", "crm:leads:create", "crm:leads:update"] });
  const viewer = await mint({ sub: userId, orgId, role: "SALES", permissions: ["crm:leads:read"] });
  const noperm = await mint({ sub: userId, orgId, role: "SALES", permissions: [] });

  let r;
  r = await req("GET", "/health/ready");
  rec("GET /health/ready -> ready", r.status === 200 && r.json?.status === "ready", `status=${r.status} body=${JSON.stringify(r.json)}`);

  r = await req("GET", "/leads");
  rec("GET /leads no token -> 401", r.status === 401 && r.json?.error === "Unauthorized", `status=${r.status}`);

  r = await req("GET", "/leads", { token: noperm });
  rec("GET /leads no-perm -> 403 RBAC_DENIED", r.status === 403 && r.json?.code === "RBAC_DENIED" && r.json?.subject === "crm:leads", `status=${r.status} body=${JSON.stringify(r.json)}`);

  r = await req("GET", "/leads?limit=5", { token: viewer });
  rec("GET /leads viewer -> 200 paginated (parity shape {leads,totalPages})", r.status === 200 && Array.isArray(r.json?.leads) && typeof r.json?.totalPages === "number", `status=${r.status} leads=${r.json?.leads?.length} totalPages=${r.json?.totalPages}`);

  r = await req("GET", "/leads?limit=500", { token: viewer });
  rec("GET /leads limit=500 -> 400 validation", r.status === 400 && /Validation failed/.test(r.json?.error ?? ""), `status=${r.status} body=${JSON.stringify(r.json)}`);

  r = await req("GET", "/leads?page=abc", { token: viewer });
  rec("GET /leads page=abc -> 400 validation", r.status === 400, `status=${r.status} body=${JSON.stringify(r.json)}`);

  r = await req("GET", "/leads/board", { token: noperm });
  rec("GET /leads/board (auth-only) -> 200", r.status === 200, `status=${r.status}`);

  r = await req("GET", "/leads/stats", { token: noperm });
  rec("GET /leads/stats (auth-only) -> 200", r.status === 200, `status=${r.status}`);

  if (sampleLeadId) {
    r = await req("GET", `/leads/${sampleLeadId}`, { token: owner });
    rec("GET /leads/:id existing -> 200", r.status === 200 && r.json?.id === sampleLeadId, `status=${r.status}`);
  }

  r = await req("GET", "/leads/999999999", { token: owner });
  rec("GET /leads/:id missing -> 404", r.status === 404, `status=${r.status} body=${JSON.stringify(r.json)}`);

  r = await req("GET", "/leads/not-a-number", { token: owner });
  rec("GET /leads/not-a-number -> 400", r.status === 400, `status=${r.status}`);

  r = await req("POST", "/leads", { token: noperm, body: { name: "ZZ_FUNCTEST_denied" } });
  rec("POST /leads no-perm -> 403", r.status === 403 && r.json?.code === "RBAC_DENIED", `status=${r.status}`);

  r = await req("POST", "/leads", { token: sales, body: {} });
  rec("POST /leads empty body -> 400 validation", r.status === 400, `status=${r.status} body=${JSON.stringify(r.json)}`);

  let newLeadId = null;
  r = await req("POST", "/leads", { token: sales, body: { name: "ZZ_FUNCTEST_lead", source: "other", priority: "WARM" } });
  if (r.status === 201 && typeof r.json?.id === "number") {
    newLeadId = r.json.id;
    created.leadIds.push(newLeadId);
  }
  rec("POST /leads create -> 201", r.status === 201 && typeof r.json?.id === "number", `status=${r.status} id=${r.json?.id}`);

  if (newLeadId) {
    r = await req("GET", `/leads/${newLeadId}`, { token: owner });
    rec("GET created lead -> 200 matches", r.status === 200 && r.json?.name === "ZZ_FUNCTEST_lead", `status=${r.status}`);

    r = await req("PATCH", `/leads/${newLeadId}`, { token: sales, body: { notes: "updated by functest" } });
    rec("PATCH lead -> 200", r.status === 200, `status=${r.status}`);

    r = await req("DELETE", `/leads/${newLeadId}`, { token: viewer });
    rec("DELETE lead no-perm -> 403", r.status === 403, `status=${r.status}`);

    r = await req("DELETE", `/leads/${newLeadId}`, { token: owner });
    if (r.status === 200) created.leadIds = created.leadIds.filter((id) => id !== newLeadId);
    rec("DELETE lead owner -> 200 (cleanup)", r.status === 200, `status=${r.status}`);
  }

  r = await req("POST", "/leads/ingest", { body: { name: "x" } });
  rec("POST /leads/ingest no key -> 401", r.status === 401 && /Missing X-API-Key/.test(r.json?.error ?? ""), `status=${r.status} body=${JSON.stringify(r.json)}`);

  r = await req("POST", "/leads/ingest", { apiKey: "totally-invalid-key", body: { name: "x" } });
  rec("POST /leads/ingest bad key -> 401", r.status === 401, `status=${r.status}`);

  if (realUserId) {
    try {
      const rawKey = `functest_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
      const keyHash = createHash("sha256").update(rawKey).digest("hex");
      const keyId = `functest_key_${Date.now()}`;
      await sql`
        INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix, scopes, is_revoked, created_by, created_at)
        VALUES (${keyId}, ${orgId}, 'functest', ${keyHash}, ${rawKey.slice(0, 8)}, ${["leads:write"]}, false, ${realUserId}, now())`;
      created.apiKeyIds.push(keyId);

      r = await req("POST", "/leads/ingest", { apiKey: rawKey, body: { name: "ZZ_FUNCTEST_ingest", email: "functest@example.com" } });
      if (r.status === 201 && typeof r.json?.id === "number") created.leadIds.push(r.json.id);
      rec("POST /leads/ingest valid key -> 201", r.status === 201 && typeof r.json?.id === "number", `status=${r.status} id=${r.json?.id}`);
    } catch (e) {
      rec("ingest valid-key setup", false, `error: ${e.message}`);
    }
  } else {
    rec("ingest valid-key", true, "skipped (no real member to own the temp key)");
  }
}

main()
  .catch((e) => {
    console.error("FATAL", e);
    rec("run", false, String(e?.message ?? e));
  })
  .finally(async () => {
    try {
      if (created.leadIds.length) await sql`DELETE FROM leads WHERE id IN ${sql(created.leadIds)}`;
    } catch (e) {
      console.error("cleanup leads failed:", e.message);
    }
    try {
      if (created.apiKeyIds.length) await sql`DELETE FROM api_keys WHERE id IN ${sql(created.apiKeyIds)}`;
    } catch (e) {
      console.error("cleanup api_keys failed:", e.message);
    }
    await sql.end({ timeout: 5 });
    const passed = results.filter((x) => x.pass).length;
    console.log(`\n=== ${passed}/${results.length} passed ===`);
    process.exit(passed === results.length ? 0 : 1);
  });
