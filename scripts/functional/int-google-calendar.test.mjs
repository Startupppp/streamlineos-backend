// Functional test: google-calendar integration module against LIVE backend (http://localhost:1500)
// Routes (all guarded only by JwtAuthGuard — no role/permission/plan guard):
//   GET  /calendar/create-meet                 -> GoogleCalendarService.getStatus(userId)
//   POST /calendar/create-meet                 -> GoogleCalendarService.createMeet(userId)   [HttpCode 200]
//   POST /hr/integrations/google-calendar      -> GoogleCalendarService.syncInterview(orgId,userId,interviewId) [Zod body]
//
// SAFETY: the functional users have NO googleRefreshToken, so createMeet/syncInterview short-circuit
// (401 "not connected" / 400 "not connected") BEFORE any Google OAuth/Calendar fetch. No real external
// Google API call is triggered by this suite. Do NOT seed a refresh token here.
import { mint, req, check, report } from "./harness.mjs";

const truthy = (name, cond) => check(name, { status: cond ? 1 : 0 }, 1);

async function main() {
  const noToken = undefined;
  const owner = await mint("owner");                                         // isOrgOwner / manage:all
  const member = await mint("member", { role: "MEMBER", plan: "free", isOrgOwner: false, permissions: [] });
  const salesRep = await mint("salesRep", { role: "SALES_REP", plan: "free", isOrgOwner: false, permissions: [] });
  const badToken = "not.a.valid.jwt";

  // ---------------------------------------------------------------------------
  // Route 1: GET /calendar/create-meet  (connection status — self-service)
  // ---------------------------------------------------------------------------
  // 401 unauthenticated
  check("GET status — no token -> 401", await req("GET", "/calendar/create-meet", { token: noToken }), 401);
  check("GET status — malformed token -> 401", await req("GET", "/calendar/create-meet", { token: badToken }), 401);

  // 200 happy path — owner. Asserts response shape: { connected, googleEmail, authUrl }.
  const gOwner = await req("GET", "/calendar/create-meet", { token: owner });
  check("GET status — owner -> 200 (no 500)", gOwner, 200);
  truthy("GET status — owner connected===false (no refresh token seeded)", gOwner.body?.connected === false);
  truthy("GET status — owner googleEmail===null", gOwner.body?.googleEmail === null);
  truthy(
    "GET status — owner authUrl points at google auth route",
    typeof gOwner.body?.authUrl === "string" && gOwner.body.authUrl.includes("/api/integrations/google/auth"),
  );

  // No RBAC on this route: a permission-less free-plan member is NOT blocked (self-service status).
  const gMember = await req("GET", "/calendar/create-meet", { token: member });
  check("GET status — member (no perms/free) -> 200 (route has no RBAC; self-service)", gMember, 200);
  truthy("GET status — member shape ok", gMember.body?.connected === false && gMember.body?.googleEmail === null);

  // ---------------------------------------------------------------------------
  // Route 2: POST /calendar/create-meet  (THE minimal safe real call)
  // ---------------------------------------------------------------------------
  // 401 unauthenticated
  check("POST create-meet — no token -> 401", await req("POST", "/calendar/create-meet", { token: noToken }), 401);
  check("POST create-meet — malformed token -> 401", await req("POST", "/calendar/create-meet", { token: badToken }), 401);

  // Graceful not-connected path. Google keys ARE configured (so 503 not-configured branch is skipped),
  // user has no refresh token -> 401 with a descriptive "not connected" message. This MUST NOT be a 500
  // and MUST short-circuit before any external Google call.
  const meetOwner = await req("POST", "/calendar/create-meet", { token: owner });
  check("POST create-meet — owner not-connected -> 401 graceful (not 500/503)", meetOwner, 401);
  truthy(
    "POST create-meet — owner body is the 'connect Google' source error (not generic Unauthorized)",
    typeof meetOwner.body?.error === "string" && /not connected/i.test(meetOwner.body.error),
  );

  // No RBAC: member reaches the same business logic (also not connected) rather than a 403/402.
  const meetMember = await req("POST", "/calendar/create-meet", { token: member });
  check("POST create-meet — member -> 401 not-connected (route has no RBAC)", meetMember, 401);
  truthy(
    "POST create-meet — member hits not-connected branch (proves no role/plan gate)",
    typeof meetMember.body?.error === "string" && /not connected/i.test(meetMember.body.error),
  );

  // ---------------------------------------------------------------------------
  // Route 3: POST /hr/integrations/google-calendar  (sync interview -> calendar)
  // ---------------------------------------------------------------------------
  // 401 unauthenticated
  check("HR sync — no token -> 401", await req("POST", "/hr/integrations/google-calendar", { token: noToken, body: { interviewId: 1 } }), 401);
  check("HR sync — malformed token -> 401", await req("POST", "/hr/integrations/google-calendar", { token: badToken, body: { interviewId: 1 } }), 401);

  // Input validation (Zod: interviewId must be a positive int) -> 400
  check("HR sync — empty body -> 400", await req("POST", "/hr/integrations/google-calendar", { token: owner, body: {} }), 400);
  check("HR sync — interviewId string -> 400", await req("POST", "/hr/integrations/google-calendar", { token: owner, body: { interviewId: "abc" } }), 400);
  check("HR sync — interviewId negative -> 400", await req("POST", "/hr/integrations/google-calendar", { token: owner, body: { interviewId: -5 } }), 400);
  check("HR sync — interviewId zero -> 400", await req("POST", "/hr/integrations/google-calendar", { token: owner, body: { interviewId: 0 } }), 400);
  check("HR sync — interviewId float -> 400", await req("POST", "/hr/integrations/google-calendar", { token: owner, body: { interviewId: 1.5 } }), 400);
  const valBody = await req("POST", "/hr/integrations/google-calendar", { token: owner, body: {} });
  truthy(
    "HR sync — validation error body is descriptive",
    typeof valBody.body?.error === "string" && /validation failed/i.test(valBody.body.error),
  );

  // Graceful resource-not-found: a well-formed but non-existent interview id -> 404 (NOT 500), and this
  // resolves before the not-connected/Google branch, so no external call.
  const sync404 = await req("POST", "/hr/integrations/google-calendar", { token: owner, body: { interviewId: 2147483000 } });
  check("HR sync — owner valid-but-missing interview -> 404 graceful (not 500)", sync404, 404);
  truthy(
    "HR sync — 404 body says interview not found",
    typeof sync404.body?.error === "string" && /not found/i.test(sync404.body.error),
  );

  // No RBAC: a permission-less member and a wrong-role (SALES_REP) user both reach the same business
  // logic on this HR-namespaced route (404), rather than being blocked with 403/402.
  const syncMember = await req("POST", "/hr/integrations/google-calendar", { token: member, body: { interviewId: 2147483000 } });
  check("HR sync — member -> 404, NOT 403 (route lacks HR role/permission guard)", syncMember, 404);
  const syncSales = await req("POST", "/hr/integrations/google-calendar", { token: salesRep, body: { interviewId: 2147483000 } });
  check("HR sync — SALES_REP -> 404, NOT 403 (route lacks HR role/permission guard)", syncSales, 404);

  const green = report("int-google-calendar");
  process.exit(green ? 0 : 1);
}

main().catch((e) => {
  console.error("Harness crashed:", e);
  process.exit(2);
});
