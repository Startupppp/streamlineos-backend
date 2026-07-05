import postgres from "postgres";
import { SignJWT } from "jose";

const DATABASE_URL = process.env.DATABASE_URL;
const SECRET = process.env.BACKEND_JWT_SECRET;
const BASE = "http://localhost:1500";
const sql = postgres(DATABASE_URL, { ssl: "require", max: 1 });

async function mint(claims) {
  return new SignJWT({
    orgId: claims.orgId,
    branchId: null,
    role: claims.role ?? "",
    permissions: [],
    enabledModules: claims.enabledModules ?? [],
    plan: null,
    isPlatformAdmin: false,
    isOrgOwner: claims.isOrgOwner === true,
    sessionId: "probe-session",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(SECRET));
}

const ENDPOINTS = [
  ["GET", "/me/access"],
  ["GET", "/kb/pages/tree"],
  ["GET", "/kb/pages/recent"],
  ["GET", "/kb/spaces"],
  ["GET", "/kb/tags"],
  ["GET", "/kb/search?q=test"],
];

async function hit(token, method, path) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 160) };
  } catch (e) {
    return { status: -1, body: e.message };
  }
}

async function sweep(label, claims) {
  const token = await mint(claims);
  console.log(`\n=== ${label} (owner=${claims.isOrgOwner}, modules=${JSON.stringify(claims.enabledModules)}) ===`);
  for (const [method, path] of ENDPOINTS) {
    const r = await hit(token, method, path);
    const mark = r.status === 200 ? "OK " : "ERR";
    console.log(`  [${mark} ${r.status}] ${method} ${path}  ${r.status === 200 ? "" : r.body}`);
  }
}

try {
  const nonOwner = await sql`
    select u.id as user_id, m.org_id, m.is_owner, m.role, o.enabled_modules
    from organization_members m
    join users u on u.id = m.user_id
    join organizations o on o.id = m.org_id
    where u.email = 'tarunchintakunta@gmail.com' and o.slug = 'kinws-mr7axa41'
    limit 1`;
  const owner = await sql`
    select u.id as user_id, m.org_id, m.is_owner, m.role, o.enabled_modules
    from organization_members m
    join users u on u.id = m.user_id
    join organizations o on o.id = m.org_id
    where u.email = 'demo@streamlineos.in'
    limit 1`;

  if (nonOwner[0]) {
    const n = nonOwner[0];
    await sweep("NON-OWNER admin in Knowledge-enabled org", {
      userId: n.user_id, orgId: n.org_id, role: n.role,
      isOrgOwner: n.is_owner, enabledModules: n.enabled_modules ?? [],
    });
  } else console.log("non-owner test user not found");

  if (owner[0]) {
    const o = owner[0];
    await sweep("OWNER (demo)", {
      userId: o.user_id, orgId: o.org_id, role: o.role,
      isOrgOwner: o.is_owner, enabledModules: o.enabled_modules ?? [],
    });
  } else console.log("owner test user not found");
} catch (e) {
  console.error("SWEEP ERROR:", e.message);
} finally {
  await sql.end({ timeout: 5 });
}
