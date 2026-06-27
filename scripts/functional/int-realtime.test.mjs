import { mint, req, check, report, ORG, USERS } from "./harness.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Integration: realtime module (src/modules/realtime)
//
// Surface enumerated from src/modules/realtime/realtime.controller.ts:
//   GET /chat/ably-token   guard: JwtAuthGuard ONLY (no RBAC / plan / role gate)
//     - 503 ServiceUnavailable when AblyService.configured === false
//     - else delegates to AblyService.createChatTokenRequest(userId, orgId)
//       (real Ably SDK call: signs a TokenRequest with ABLY_API_KEY)
//
// AblyService.createChatTokenRequest scopes the token to the *authenticated*
// claims only: clientId = JWT.sub, capability = { `chat:${JWT.orgId}:*`: [...] }.
// There is NO request input (body/query/param) that can widen that scope.
//
// WebPushService has NO HTTP route in this module (it is a provider consumed by
// the chat/notifications modules), so it is out of scope for route testing here.
//
// SAFE REAL CALL: GET /chat/ably-token with owner. createTokenRequest computes a
// signed TokenRequest locally from the API key (no billable network call, sends
// no messages) — harmless + free. We assert its shape + user/org scoping.
// ─────────────────────────────────────────────────────────────────────────────

const owner = await mint("owner");
const member = await mint("member");

// thin boolean-assertion adapter so shape/scoping checks feed the harness counters
const ok = (name, cond, info) =>
  check(name, { status: cond ? 200 : 598, body: info ? { error: info } : undefined }, 200);

// ─────────────────────────────────────────────────────────────────────────────
// 1) AUTHN — every request without a *valid* bearer must 401 (JwtAuthGuard)
// ─────────────────────────────────────────────────────────────────────────────
{
  const noTok = await req("GET", "/chat/ably-token", {});
  check("no-token GET /chat/ably-token -> 401", noTok, 401);
  ok("no-token body is { error: 'Unauthorized' }", noTok.body?.error === "Unauthorized", JSON.stringify(noTok.body));

  // garbage / non-JWT bearer -> 401 (jwtVerify throws)
  check("garbage-bearer -> 401", await req("GET", "/chat/ably-token", { token: "not-a-jwt" }), 401);

  // token signed with the WRONG secret -> 401 (signature verify fails)
  const { SignJWT } = await import("jose");
  const forged = await new SignJWT({ sub: USERS.owner.sub, orgId: ORG, role: "OWNER" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("wrong-secret-".padEnd(44, "x")));
  check("wrong-secret JWT -> 401", await req("GET", "/chat/ably-token", { token: forged }), 401);

  // valid signature but NO orgId claim -> guard rejects ("Organization not found")
  const noOrg = await mint("owner", { orgId: undefined });
  const noOrgRes = await req("GET", "/chat/ably-token", { token: noOrg });
  check("valid JWT missing orgId -> 401", noOrgRes, 401);

  // expired token -> 401
  const expired = await new SignJWT({ sub: USERS.owner.sub, orgId: ORG, role: "OWNER" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(new TextEncoder().encode(process.env.BACKEND_JWT_SECRET));
  check("expired JWT -> 401", await req("GET", "/chat/ably-token", { token: expired }), 401);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) RBAC / ENTITLEMENT — this route is AUTH-ONLY by design (no permission, no
//    plan, no role gate). True behavior: ANY authenticated org user gets a token.
//    We assert it is neither over-gated (no false 403/402) nor a 500.
// ─────────────────────────────────────────────────────────────────────────────
{
  check("member (no perms) -> 200 (auth-only, not over-gated)", await req("GET", "/chat/ably-token", { token: member }), 200);

  const freePlan = await mint("member", { plan: "free", enabledModules: [] });
  check("free-plan member -> 200 (no plan/entitlement gate)", await req("GET", "/chat/ably-token", { token: freePlan }), 200);

  const oddRole = await mint("member", { role: "JANITOR", permissions: [] });
  check("arbitrary role -> 200 (no role gate)", await req("GET", "/chat/ably-token", { token: oddRole }), 200);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) INPUT VALIDATION — GET consumes no body/query/param. Junk query params must
//    be ignored (no 400/422 surface to validate, and must not 500).
// ─────────────────────────────────────────────────────────────────────────────
{
  const junk = await req("GET", "/chat/ably-token?channelId=not-a-number&foo[]=bar&x=%ff", { token: owner });
  check("junk query params ignored -> 200 (no input surface)", junk, 200);
  ok("junk-query did not 500", junk.status !== 500, `status ${junk.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) GRACEFUL NOT-CONFIGURED PATH — when AblyService.configured is false the
//    handler throws ServiceUnavailable (503), NOT an unhandled 500. ABLY_API_KEY
//    IS present on this live backend, so the live response is the configured 200
//    path; the 503 branch is verified by code inspection (typed ServiceUnavailable
//    -> filter maps to 503 { error: "Ably is not configured" }). Here we assert
//    the configured path is healthy: 200 and never 500/503.
// ─────────────────────────────────────────────────────────────────────────────
{
  const live = await req("GET", "/chat/ably-token", { token: owner });
  check("configured path -> 200 (not 503/500)", live, 200);
  ok("configured path is not 503", live.status !== 503, `status ${live.status}`);
  ok("configured path is not 500", live.status !== 500, `status ${live.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) SAFE REAL CALL — owner GET /chat/ably-token: assert valid Ably TokenRequest
//    shape + that it is scoped to THIS user (clientId) and THIS org (capability).
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = await req("GET", "/chat/ably-token", { token: owner });
  check("REAL owner GET /chat/ably-token -> 200", r, 200);
  const t = r.body && typeof r.body === "object" ? r.body : {};

  // TokenRequest shape (Ably.TokenRequest): keyName, clientId, capability, ttl,
  // timestamp, nonce, mac
  ok("shape: keyName is non-empty string", typeof t.keyName === "string" && t.keyName.length > 0, JSON.stringify(t.keyName));
  ok("shape: mac is non-empty string (signature)", typeof t.mac === "string" && t.mac.length > 0, JSON.stringify(t.mac));
  ok("shape: nonce is non-empty string", typeof t.nonce === "string" && t.nonce.length > 0, JSON.stringify(t.nonce));
  ok("shape: timestamp is a number", typeof t.timestamp === "number" && t.timestamp > 0, JSON.stringify(t.timestamp));
  ok("shape: ttl === 3600000 (1h)", t.ttl === 3_600_000, JSON.stringify(t.ttl));
  ok("shape: capability is a string", typeof t.capability === "string", JSON.stringify(t.capability));

  // SCOPING: clientId bound to the authenticated user
  ok("scope: clientId === authenticated user.sub", t.clientId === USERS.owner.sub, JSON.stringify(t.clientId));

  // SCOPING: capability bound to the authenticated org, single namespaced key
  let cap = {};
  try { cap = JSON.parse(t.capability ?? "{}"); } catch { cap = {}; }
  const capKeys = Object.keys(cap);
  ok("scope: capability has exactly one resource key", capKeys.length === 1, JSON.stringify(capKeys));
  ok(`scope: capability key === chat:${ORG}:*`, capKeys[0] === `chat:${ORG}:*`, JSON.stringify(capKeys[0]));
  const ops = Array.isArray(cap[`chat:${ORG}:*`]) ? cap[`chat:${ORG}:*`] : [];
  ok("scope: ops = subscribe+publish+history", ["history", "publish", "subscribe"].every((o) => ops.includes(o)), JSON.stringify(ops));
  // must NOT be a cross-org wildcard
  ok("scope: no cross-org wildcard '*' / '*:*'", !capKeys.some((k) => k === "*" || k === "[*]*" || k === "*:*"), JSON.stringify(capKeys));
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) PER-USER / PER-ORG SCOPING — token scope derives from the verified JWT only.
//    A different user => different clientId. A different orgId claim => capability
//    re-scoped to that org. There is no request param to choose user/org, so a
//    caller can never mint a token for an org/user other than their own claims.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rm = await req("GET", "/chat/ably-token", { token: member });
  check("member REAL GET -> 200", rm, 200);
  ok("per-user: member token clientId === member.sub", rm.body?.clientId === USERS.member.sub, JSON.stringify(rm.body?.clientId));

  const otherOrg = "11111111-2222-3333-4444-555555555555";
  const altOrgTok = await mint("owner", { orgId: otherOrg });
  const ra = await req("GET", "/chat/ably-token", { token: altOrgTok });
  check("alt-org JWT REAL GET -> 200", ra, 200);
  let acap = {};
  try { acap = JSON.parse(ra.body?.capability ?? "{}"); } catch { acap = {}; }
  ok("per-org: capability re-scoped to the JWT's orgId", Object.keys(acap)[0] === `chat:${otherOrg}:*`, JSON.stringify(Object.keys(acap)));
  ok("per-org: alt-org token does NOT grant default-org channels", Object.keys(acap)[0] !== `chat:${ORG}:*`, JSON.stringify(Object.keys(acap)));
}

const okAll = report("int-realtime");
process.exitCode = okAll ? 0 : 1;
