import { SignJWT } from "jose";

export const BASE_URL = process.env.FN_BASE_URL ?? "http://localhost:1500";
export const ORG = "43aa1af7-aa55-4015-85ac-0d86677903f2";

const SECRET = process.env.BACKEND_JWT_SECRET;
if (!SECRET) {
  console.error("BACKEND_JWT_SECRET not in env — run with: set -a; . ./.env; set +a; node <script>");
  process.exit(2);
}
const key = new TextEncoder().encode(SECRET);

export const USERS = {
  owner: { sub: "a723ac2d-0b0a-4f24-a3ae-f4605af20bbb", role: "OWNER", isOrgOwner: true },
  platform: { sub: "user_ajm82g8nOnLuvlPZaXrVG", role: "PLATFORM_OWNER", isPlatformAdmin: true },
  hrManager: { sub: "062be179-8715-4a24-a34d-b4e7219c04ee", role: "HR_MANAGER" },
  salesRep: { sub: "fb0c586a-399a-45fa-bffc-894bcf4430f6", role: "SALES_REP" },
  member: { sub: "324a13ef-cb53-4c31-894d-887a45e23b1d", role: "MEMBER" },
};

export async function mint(who, overrides = {}) {
  const u = typeof who === "string" ? USERS[who] : who;
  const claims = {
    sub: u.sub,
    orgId: ORG,
    role: u.role,
    branchId: null,
    permissions: u.permissions ?? [],
    enabledModules: u.enabledModules ?? [],
    plan: u.plan ?? "enterprise",
    isPlatformAdmin: u.isPlatformAdmin === true,
    isOrgOwner: u.isOrgOwner === true,
    sessionId: "fn-test-session",
    ...overrides,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

export async function req(method, path, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  const text = await res.text();
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

let pass = 0, fail = 0;
const failures = [];
export function check(name, got, wantStatus) {
  const wants = Array.isArray(wantStatus) ? wantStatus : [wantStatus];
  const ok = wants.includes(got.status);
  if (ok) pass++;
  else { fail++; failures.push(`${name} — expected ${wants.join("|")} got ${got.status}${got.body?.error ? ` (${got.body.error})` : ""}`); }
  return ok;
}
export function report(label) {
  console.log(`\n[${label}] ${pass} passed, ${fail} failed`);
  for (const f of failures) console.log("  FAIL: " + f);
  return fail === 0;
}
