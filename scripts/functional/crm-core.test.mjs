import { mint, req, check, report } from "./harness.mjs";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function asArray(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    for (const k of ["items", "data", "rows", "results", "records", "list"]) {
      if (Array.isArray(body[k])) return body[k];
    }
    for (const v of Object.values(body)) if (Array.isArray(v)) return v;
  }
  return [];
}
function firstId(body, key = "id") {
  const found = asArray(body).find((x) => x && x[key] != null);
  return found ? found[key] : null;
}
const FAKE = 999999999; // non-existent numeric id
const NOTNUM = "not-a-number"; // triggers ParseIntPipe -> 400

async function main() {
  const owner = await mint("owner");
  const member = await mint("member");
  const salesRep = await mint("salesRep");

  // =========================================================================
  // CONTACTS  (/contacts) — JwtAuthGuard, auth-only (no ability gate)
  // =========================================================================
  // AUTH
  check("AUTH GET /contacts no-token", await req("GET", "/contacts"), 401);
  // HAPPY (owner)
  const contactsList = await req("GET", "/contacts", { token: owner });
  check("GET /contacts owner", contactsList, 200);
  check("GET /contacts/search owner", await req("GET", "/contacts/search?q=an", { token: owner }), 200);
  // auth-only -> member not over-gated
  check("GET /contacts member (auth-only)", await req("GET", "/contacts", { token: member }), 200);
  // ERROR paths
  check("GET /contacts/:id 404", await req("GET", `/contacts/${FAKE}`, { token: owner }), 404);
  check("GET /contacts/:id 400 non-numeric", await req("GET", `/contacts/${NOTNUM}`, { token: owner }), 400);
  check("POST /contacts 400 empty body", await req("POST", "/contacts", { token: owner, body: {} }), 400);
  // WRITE round-trip (FN_TEST_, then DELETE)
  const cCreate = await req("POST", "/contacts", { token: owner, body: { name: "FN_TEST_contact", tags: [] } });
  check("POST /contacts create", cCreate, [200, 201]);
  const cId = cCreate.body?.id;
  if (cId != null) {
    check("GET /contacts/:id created", await req("GET", `/contacts/${cId}`, { token: owner }), 200);
    check("GET /contacts/:id/vcard", await req("GET", `/contacts/${cId}/vcard`, { token: owner }), 200);
    check("PATCH /contacts/:id", await req("PATCH", `/contacts/${cId}`, { token: owner, body: { title: "FN_TEST" } }), 200);
    check("DELETE /contacts/:id", await req("DELETE", `/contacts/${cId}`, { token: owner }), [200, 204]);
  }

  // =========================================================================
  // TARGETS  (/targets) — JwtAuthGuard, service-level role gate on writes
  // =========================================================================
  check("AUTH GET /targets no-token", await req("GET", "/targets"), 401);
  check("GET /targets owner", await req("GET", "/targets", { token: owner }), 200);
  check("GET /targets/my owner", await req("GET", "/targets/my", { token: owner }), 200);
  check("GET /targets/leaderboard owner", await req("GET", "/targets/leaderboard", { token: owner }), 200);
  check("GET /targets member (auth-only list)", await req("GET", "/targets", { token: member }), 200);
  check("GET /targets/:id/history 200 (empty ok)", await req("GET", `/targets/${FAKE}/history`, { token: owner }), 200);
  check("PATCH /targets/:id 404", await req("PATCH", `/targets/${FAKE}`, { token: owner, body: { notes: "x" } }), 404);
  check("POST /targets 400 empty body", await req("POST", "/targets", { token: owner, body: {} }), 400);
  // RBAC negative: member (non-admin, no reports) cannot create a target -> 403
  check("POST /targets member RBAC", await req("POST", "/targets", {
    token: member,
    body: { userId: "a723ac2d-0b0a-4f24-a3ae-f4605af20bbb", metricType: "calls", targetValue: "10", startDate: "2026-01-01", endDate: "2026-01-31" },
  }), 403);
  // WRITE round-trip: owner sets a target for self (no notification side-effect), then delete
  const tCreate = await req("POST", "/targets", {
    token: owner,
    body: { userId: "a723ac2d-0b0a-4f24-a3ae-f4605af20bbb", metricType: "fn_test_metric", targetValue: "100", period: "daily", startDate: "2026-01-01", endDate: "2026-01-31", notes: "FN_TEST_target" },
  });
  check("POST /targets create owner", tCreate, [200, 201]);
  const tId = Array.isArray(tCreate.body) ? tCreate.body[0]?.id : tCreate.body?.id;
  if (tId != null) {
    check("GET /targets/:id/history created", await req("GET", `/targets/${tId}/history`, { token: owner }), 200);
    check("PATCH /targets/:id owner", await req("PATCH", `/targets/${tId}`, { token: owner, body: { currentValue: "5" } }), 200);
    check("DELETE /targets/:id owner", await req("DELETE", `/targets/${tId}`, { token: owner }), [200, 204]);
  }

  // =========================================================================
  // CSAT  (/csat) — JwtAuthGuard; submitResponse is @Public
  // =========================================================================
  check("AUTH GET /csat no-token", await req("GET", "/csat"), 401);
  check("GET /csat owner", await req("GET", "/csat", { token: owner }), 200);
  check("GET /csat member (auth-only)", await req("GET", "/csat", { token: member }), 200);
  check("GET /csat/:id 404", await req("GET", `/csat/${FAKE}`, { token: owner }), 404);
  check("GET /csat/:id 400 non-numeric", await req("GET", `/csat/${NOTNUM}`, { token: owner }), 400);
  check("POST /csat 400 empty body", await req("POST", "/csat", { token: owner, body: {} }), 400);
  // @Public submit: no token must NOT be 401; non-existent/non-sent survey -> 404
  check("POST /csat/:id/responses @Public no-token -> 404 not 401", await req("POST", `/csat/${FAKE}/responses`, { body: { rating: 5 } }), 404);
  check("POST /csat/:id/responses @Public bad rating -> 400", await req("POST", `/csat/${FAKE}/responses`, { body: { rating: 99 } }), 400);
  // WRITE round-trip incl public submit against a sent FN_TEST survey
  const sCreate = await req("POST", "/csat", { token: owner, body: { title: "FN_TEST_survey", scaleMax: 5 } });
  check("POST /csat create", sCreate, 201);
  const sId = sCreate.body?.id;
  if (sId != null) {
    check("GET /csat/:id created", await req("GET", `/csat/${sId}`, { token: owner }), 200);
    check("GET /csat/:id/responses", await req("GET", `/csat/${sId}/responses`, { token: owner }), 200);
    check("PATCH /csat/:id -> sent", await req("PATCH", `/csat/${sId}`, { token: owner, body: { status: "sent" } }), 200);
    check("POST /csat/:id/responses @Public valid -> 201", await req("POST", `/csat/${sId}/responses`, { body: { rating: 4, comment: "FN_TEST" } }), 201);
    check("POST /csat/:id/responses @Public out-of-range -> 400", await req("POST", `/csat/${sId}/responses`, { body: { rating: 9 } }), 400);
    check("DELETE /csat/:id", await req("DELETE", `/csat/${sId}`, { token: owner }), [200, 204]);
  }

  // =========================================================================
  // CLIENTS  (/clients) — JwtAuthGuard + inline role-string gates
  // =========================================================================
  check("AUTH GET /clients no-token", await req("GET", "/clients"), 401);
  check("GET /clients owner", await req("GET", "/clients", { token: owner }), 200);
  check("GET /clients/list owner", await req("GET", "/clients/list", { token: owner }), 200);
  check("GET /clients/health owner", await req("GET", "/clients/health", { token: owner }), 200);
  check("GET /clients/churn-alerts owner", await req("GET", "/clients/churn-alerts", { token: owner }), 200);
  check("GET /clients/assign-crm owner", await req("GET", "/clients/assign-crm", { token: owner }), 200);
  check("GET /clients/renewals owner", await req("GET", "/clients/renewals", { token: owner }), 200);
  check("GET /clients/opportunities owner", await req("GET", "/clients/opportunities", { token: owner }), 200);
  check("GET /clients/onboarding/items owner", await req("GET", "/clients/onboarding/items", { token: owner }), 200);
  check("GET /clients/onboarding/templates owner", await req("GET", "/clients/onboarding/templates", { token: owner }), 200);
  check("GET /clients member (auth-only list)", await req("GET", "/clients", { token: member }), 200);
  check("GET /clients/:id 404", await req("GET", `/clients/${FAKE}`, { token: owner }), 404);
  check("GET /clients/:id 400 non-numeric", await req("GET", `/clients/${NOTNUM}`, { token: owner }), 400);
  check("GET /clients/:id/activities owner", await req("GET", `/clients/${FAKE}/activities`, { token: owner }), 200);
  check("GET /clients/:id/timeline 404", await req("GET", `/clients/${FAKE}/timeline`, { token: owner }), 404);
  // RBAC negatives (role-string gated writes)
  check("PATCH /clients/renewals/:id member RBAC", await req("PATCH", `/clients/renewals/${FAKE}`, { token: member, body: { renewalStage: "renewed" } }), 403);
  check("POST /clients/:id/activities member RBAC", await req("POST", `/clients/${FAKE}/activities`, { token: member, body: { activityType: "call", title: "x" } }), 403);
  check("POST /clients/onboarding/templates member RBAC", await req("POST", "/clients/onboarding/templates", { token: member, body: { name: "FN_TEST" } }), 403);
  check("POST /clients/opportunities 400 empty body", await req("POST", "/clients/opportunities", { token: owner, body: {} }), 400);
  check("POST /clients/opportunities 404 bad client", await req("POST", "/clients/opportunities", { token: owner, body: { clientId: FAKE, title: "FN_TEST_opp" } }), 404);
  check("PATCH /clients/opportunities/:id 404", await req("PATCH", `/clients/opportunities/${FAKE}`, { token: owner, body: { stage: "won" } }), 404);
  check("DELETE /clients/opportunities/:id 404", await req("DELETE", `/clients/opportunities/${FAKE}`, { token: owner }), 404);
  check("PATCH /clients/onboarding/items/:id 404", await req("PATCH", `/clients/onboarding/items/${FAKE}`, { token: owner, body: { title: "x" } }), 404);
  check("DELETE /clients/onboarding/items/:id 404", await req("DELETE", `/clients/onboarding/items/${FAKE}`, { token: owner }), 404);
  // WRITE round-trip on a real client if one exists (opportunity create/patch/delete)
  const clientsList = await req("GET", "/clients/list", { token: owner });
  const realClientId = firstId(clientsList);
  if (realClientId != null) {
    const detail = await req("GET", `/clients/${realClientId}`, { token: owner });
    check("GET /clients/:id real", detail, 200);
    check("GET /clients/:id/activities real", await req("GET", `/clients/${realClientId}/activities`, { token: owner }), 200);
    check("GET /clients/:id/timeline real", await req("GET", `/clients/${realClientId}/timeline`, { token: owner }), 200);
    const oppCreate = await req("POST", "/clients/opportunities", { token: owner, body: { clientId: Number(realClientId), title: "FN_TEST_opp" } });
    check("POST /clients/opportunities create", oppCreate, [200, 201]);
    const oppId = oppCreate.body?.id;
    if (oppId != null) {
      check("PATCH /clients/opportunities/:id", await req("PATCH", `/clients/opportunities/${oppId}`, { token: owner, body: { stage: "proposed" } }), 200);
      check("DELETE /clients/opportunities/:id", await req("DELETE", `/clients/opportunities/${oppId}`, { token: owner }), [200, 204]);
    }
    const itemCreate = await req("POST", "/clients/onboarding/items", { token: owner, body: { clientId: Number(realClientId), title: "FN_TEST_item" } });
    check("POST /clients/onboarding/items create", itemCreate, [200, 201]);
    const itemId = itemCreate.body?.id;
    if (itemId != null) {
      check("PATCH /clients/onboarding/items/:id", await req("PATCH", `/clients/onboarding/items/${itemId}`, { token: owner, body: { title: "FN_TEST_item2" } }), 200);
      check("DELETE /clients/onboarding/items/:id", await req("DELETE", `/clients/onboarding/items/${itemId}`, { token: owner }), [200, 204]);
    }
  }

  // =========================================================================
  // QUOTES  (/quotes) — JwtAuthGuard + AbilityGuard (DELETE needs delete crm:quotes)
  // =========================================================================
  check("AUTH GET /quotes no-token", await req("GET", "/quotes"), 401);
  check("GET /quotes owner", await req("GET", "/quotes", { token: owner }), 200);
  check("GET /quotes/export owner", await req("GET", "/quotes/export", { token: owner }), 200);
  check("GET /quotes member (no ability gate on GET)", await req("GET", "/quotes", { token: member }), 200);
  check("GET /quotes/:id 404", await req("GET", `/quotes/${FAKE}`, { token: owner }), 404);
  check("GET /quotes/:id 400 non-numeric", await req("GET", `/quotes/${NOTNUM}`, { token: owner }), 400);
  check("POST /quotes 400 empty body", await req("POST", "/quotes", { token: owner, body: {} }), 400);
  check("DELETE /quotes/:id member RBAC (delete crm:quotes)", await req("DELETE", `/quotes/${FAKE}`, { token: member }), 403);
  // WRITE round-trip: create draft -> send -> delete (owner has manage all)
  const qCreate = await req("POST", "/quotes", {
    token: owner,
    body: { subject: "FN_TEST_quote", validUntil: "2030-01-01", lineItems: [{ description: "FN_TEST item", quantity: 1, unitPrice: 10 }] },
  });
  check("POST /quotes create", qCreate, 201);
  const qId = qCreate.body?.id;
  if (qId != null) {
    check("GET /quotes/:id created", await req("GET", `/quotes/${qId}`, { token: owner }), 200);
    check("PATCH /quotes/:id", await req("PATCH", `/quotes/${qId}`, { token: owner, body: { notes: "FN_TEST" } }), 200);
    check("POST /quotes/:id/send", await req("POST", `/quotes/${qId}/send`, { token: owner }), [200, 201]);
    check("DELETE /quotes/:id owner", await req("DELETE", `/quotes/${qId}`, { token: owner }), [200, 204]);
  }

  // =========================================================================
  // CUSTOMER-EXECUTIVE  (/customer-executive) — JwtAuthGuard + AbilityGuard
  // =========================================================================
  check("AUTH GET /customer-executive/health no-token", await req("GET", "/customer-executive/health"), 401);
  check("GET /customer-executive/health owner", await req("GET", "/customer-executive/health", { token: owner }), 200);
  check("GET /customer-executive/health/config owner", await req("GET", "/customer-executive/health/config", { token: owner }), 200);
  check("GET /customer-executive/nps owner", await req("GET", "/customer-executive/nps", { token: owner }), 200);
  check("GET /customer-executive/nps/stats owner", await req("GET", "/customer-executive/nps/stats", { token: owner }), 200);
  check("GET /customer-executive/sla owner", await req("GET", "/customer-executive/sla", { token: owner }), 200);
  check("GET /customer-executive/sla member (auth-only)", await req("GET", "/customer-executive/sla", { token: member }), 200);
  check("GET /customer-executive/nps/:id 404", await req("GET", `/customer-executive/nps/${FAKE}`, { token: owner }), 404);
  // RBAC negatives: ability-gated routes -> member 403
  check("GET /customer-executive/health member RBAC", await req("GET", "/customer-executive/health", { token: member }), 403);
  check("GET /customer-executive/nps member RBAC", await req("GET", "/customer-executive/nps", { token: member }), 403);
  check("PUT /customer-executive/health/config member RBAC", await req("PUT", "/customer-executive/health/config", { token: member, body: {} }), 403);
  check("POST /customer-executive/health/recompute member RBAC", await req("POST", "/customer-executive/health/recompute", { token: member }), 403);
  check("POST /customer-executive/nps member RBAC", await req("POST", "/customer-executive/nps", { token: member, body: { title: "FN_TEST", question: "q?" } }), 403);
  // WRITE round-trip (owner manage all): create NPS survey -> get -> patch -> delete
  const npsCreate = await req("POST", "/customer-executive/nps", { token: owner, body: { title: "FN_TEST_nps", question: "How likely?" } });
  check("POST /customer-executive/nps create", npsCreate, [200, 201]);
  const npsId = npsCreate.body?.id;
  if (npsId != null) {
    check("GET /customer-executive/nps/:id created", await req("GET", `/customer-executive/nps/${npsId}`, { token: owner }), 200);
    check("PATCH /customer-executive/nps/:id", await req("PATCH", `/customer-executive/nps/${npsId}`, { token: owner, body: { title: "FN_TEST_nps2" } }), 200);
    check("DELETE /customer-executive/nps/:id", await req("DELETE", `/customer-executive/nps/${npsId}`, { token: owner }), [200, 204]);
  }

  // =========================================================================
  // REPORTS  (/reports) — JwtAuthGuard, service-level permission gates
  // =========================================================================
  check("AUTH GET /reports/attendance no-token", await req("GET", "/reports/attendance?startDate=2026-01-01&endDate=2026-01-31"), 401);
  check("GET /reports/attendance owner", await req("GET", "/reports/attendance?startDate=2026-01-01&endDate=2026-01-31", { token: owner }), 200);
  check("GET /reports/payroll owner (empty ok)", await req("GET", "/reports/payroll?startMonth=2026-01&endMonth=2026-03", { token: owner }), 200);
  check("GET /reports/project owner", await req("GET", "/reports/project", { token: owner }), 200);
  check("GET /reports/team-performance owner", await req("GET", "/reports/team-performance?startDate=2026-01-01&endDate=2026-03-31", { token: owner }), 200);
  check("GET /reports/source-effectiveness owner", await req("GET", "/reports/source-effectiveness", { token: owner }), 200);
  check("GET /reports/attendance 400 missing dates", await req("GET", "/reports/attendance", { token: owner }), 400);
  check("GET /reports/source-effectiveness member (auth-only)", await req("GET", "/reports/source-effectiveness", { token: member }), 200);

  // =========================================================================
  // SALES  (/sales) — JwtAuthGuard + inline ability + AbilityGuard
  // =========================================================================
  check("AUTH GET /sales/commission-rules no-token", await req("GET", "/sales/commission-rules"), 401);
  check("GET /sales/commission-rules owner", await req("GET", "/sales/commission-rules", { token: owner }), 200);
  check("GET /sales/commissions owner", await req("GET", "/sales/commissions", { token: owner }), 200);
  check("GET /sales/quotas owner", await req("GET", "/sales/quotas", { token: owner }), 200);
  check("GET /sales/playbook owner", await req("GET", "/sales/playbook", { token: owner }), 200);
  check("GET /sales/dashboard/kpis owner", await req("GET", "/sales/dashboard/kpis", { token: owner }), 200);
  check("GET /sales/dashboard/funnel owner", await req("GET", "/sales/dashboard/funnel", { token: owner }), 200);
  check("GET /sales/dashboard/leaderboard owner", await req("GET", "/sales/dashboard/leaderboard", { token: owner }), 200);
  check("GET /sales/dashboard/revenue-vs-goal owner", await req("GET", "/sales/dashboard/revenue-vs-goal", { token: owner }), 200);
  check("GET /sales/dashboard/velocity owner", await req("GET", "/sales/dashboard/velocity", { token: owner }), 200);
  check("GET /sales/dashboard/aging owner", await req("GET", "/sales/dashboard/aging", { token: owner }), 200);
  check("GET /sales/dashboard/cohort owner", await req("GET", "/sales/dashboard/cohort", { token: owner }), 200);
  check("GET /sales/dashboard/cycle-length owner", await req("GET", "/sales/dashboard/cycle-length", { token: owner }), 200);
  check("GET /sales/dashboard/lost-analysis owner", await req("GET", "/sales/dashboard/lost-analysis", { token: owner }), 200);
  check("GET /sales/commissions member (auth-only)", await req("GET", "/sales/commissions", { token: member }), 200);
  // RBAC negatives
  check("GET /sales/commission-rules member RBAC (view sales)", await req("GET", "/sales/commission-rules", { token: member }), 403);
  check("POST /sales/commission-rules member RBAC (manage settings)", await req("POST", "/sales/commission-rules", { token: member, body: { name: "FN_TEST", flatRate: "10" } }), 403);
  check("GET /sales/playbook member RBAC (view sales)", await req("GET", "/sales/playbook", { token: member }), 403);
  check("POST /sales/playbook member RBAC (manage sales)", await req("POST", "/sales/playbook", { token: member, body: { title: "FN_TEST" } }), 403);
  check("PATCH /sales/commissions/:id member RBAC (manage sales)", await req("PATCH", `/sales/commissions/${FAKE}`, { token: member, body: { status: "approved" } }), 403);
  check("GET /sales/dashboard/cycle-length member RBAC (read crm:deals)", await req("GET", "/sales/dashboard/cycle-length", { token: member }), 403);
  check("POST /sales/quotas member RBAC (managers only)", await req("POST", "/sales/quotas", { token: member, body: { userId: "x", startDate: "2026-01-01", endDate: "2026-12-31", targetRevenue: "1000" } }), 403);
  // ERROR paths
  check("PATCH /sales/commissions/:id 404 owner", await req("PATCH", `/sales/commissions/${FAKE}`, { token: owner, body: { status: "approved" } }), 404);
  check("POST /sales/commission-rules 400 empty body owner", await req("POST", "/sales/commission-rules", { token: owner, body: {} }), 400);
  check("GET /sales/dashboard/rep-comparison 400 missing", await req("GET", "/sales/dashboard/rep-comparison", { token: owner }), 400);
  check("GET /sales/dashboard/rep-comparison 400 non-numeric", await req("GET", "/sales/dashboard/rep-comparison?rep1=a&rep2=b", { token: owner }), 400);
  check("GET /sales/dashboard/rep-comparison 404 unknown reps", await req("GET", `/sales/dashboard/rep-comparison?rep1=${FAKE}&rep2=${FAKE - 1}`, { token: owner }), 404);
  // WRITE round-trip: playbook entry (owner manage all -> create/patch/delete)
  const pbCreate = await req("POST", "/sales/playbook", { token: owner, body: { title: "FN_TEST_playbook", content: "FN_TEST" } });
  check("POST /sales/playbook create owner", pbCreate, 201);
  const pbId = pbCreate.body?.id;
  if (pbId != null) {
    check("PATCH /sales/playbook/:id", await req("PATCH", `/sales/playbook/${pbId}`, { token: owner, body: { title: "FN_TEST_playbook2" } }), 200);
    check("DELETE /sales/playbook/:id", await req("DELETE", `/sales/playbook/${pbId}`, { token: owner }), [200, 204]);
  }

  // =========================================================================
  // CRM ORGANIZATIONS  (/crm/organizations) — JwtAuthGuard auth-only
  // =========================================================================
  check("AUTH GET /crm/organizations no-token", await req("GET", "/crm/organizations"), 401);
  check("GET /crm/organizations owner", await req("GET", "/crm/organizations", { token: owner }), 200);
  check("GET /crm/organizations member (auth-only)", await req("GET", "/crm/organizations", { token: member }), 200);
  check("GET /crm/organizations/:id 404", await req("GET", `/crm/organizations/${FAKE}`, { token: owner }), 404);
  check("GET /crm/organizations/:id 400 non-numeric", await req("GET", `/crm/organizations/${NOTNUM}`, { token: owner }), 400);
  check("GET /crm/organizations/:id/hierarchy 404", await req("GET", `/crm/organizations/${FAKE}/hierarchy`, { token: owner }), 404);
  check("GET /crm/organizations/:id/related-leads 404", await req("GET", `/crm/organizations/${FAKE}/related-leads`, { token: owner }), 404);
  check("POST /crm/organizations 400 empty body", await req("POST", "/crm/organizations", { token: owner, body: {} }), 400);
  // WRITE round-trip
  const orgCreate = await req("POST", "/crm/organizations", { token: owner, body: { name: "FN_TEST_org" } });
  check("POST /crm/organizations create", orgCreate, 201);
  const orgId = orgCreate.body?.id;
  if (orgId != null) {
    check("GET /crm/organizations/:id created", await req("GET", `/crm/organizations/${orgId}`, { token: owner }), 200);
    check("GET /crm/organizations/:id/hierarchy", await req("GET", `/crm/organizations/${orgId}/hierarchy`, { token: owner }), 200);
    check("GET /crm/organizations/:id/related-leads", await req("GET", `/crm/organizations/${orgId}/related-leads`, { token: owner }), 200);
    check("GET /crm/organizations/:id/roll-up", await req("GET", `/crm/organizations/${orgId}/roll-up`, { token: owner }), 200);
    check("GET /crm/organizations/:id/timeline", await req("GET", `/crm/organizations/${orgId}/timeline`, { token: owner }), 200);
    check("PATCH /crm/organizations/:id", await req("PATCH", `/crm/organizations/${orgId}`, { token: owner, body: { industry: "FN_TEST" } }), 200);
    check("DELETE /crm/organizations/:id", await req("DELETE", `/crm/organizations/${orgId}`, { token: owner }), [200, 204]);
  }

  // =========================================================================
  // CRM PEOPLE  (/crm/people-slugs, /crm/people/:slug) — JwtAuthGuard auth-only
  // =========================================================================
  check("AUTH GET /crm/people-slugs no-token", await req("GET", "/crm/people-slugs"), 401);
  const slugsRes = await req("GET", "/crm/people-slugs", { token: owner });
  check("GET /crm/people-slugs owner", slugsRes, 200);
  check("GET /crm/people-slugs member (auth-only)", await req("GET", "/crm/people-slugs", { token: member }), 200);
  check("GET /crm/people/:slug 404 unknown", await req("GET", "/crm/people/FN_TEST_unknown_slug", { token: owner }), 404);
  const aSlug = slugsRes.body && typeof slugsRes.body === "object" ? Object.values(slugsRes.body)[0] : null;
  if (aSlug) {
    check("GET /crm/people/:slug real", await req("GET", `/crm/people/${encodeURIComponent(aSlug)}`, { token: owner }), 200);
  }

  // =========================================================================
  // CRM SLA  (/crm/sla) — JwtAuthGuard; policy writes gated manage crm:sla
  // =========================================================================
  check("AUTH GET /crm/sla/policies no-token", await req("GET", "/crm/sla/policies"), 401);
  check("GET /crm/sla/policies owner", await req("GET", "/crm/sla/policies", { token: owner }), 200);
  check("GET /crm/sla/breached owner", await req("GET", "/crm/sla/breached", { token: owner }), 200);
  check("GET /crm/sla/report owner", await req("GET", "/crm/sla/report", { token: owner }), 200);
  check("GET /crm/sla/policies member (auth-only)", await req("GET", "/crm/sla/policies", { token: member }), 200);
  check("POST /crm/sla/policies member RBAC", await req("POST", "/crm/sla/policies", { token: member, body: { name: "FN_TEST", appliesTo: "lead", priority: "high", firstResponseHours: 1, resolutionHours: 8 } }), 403);
  check("PATCH /crm/sla/policies/:id 404 owner", await req("PATCH", `/crm/sla/policies/${FAKE}`, { token: owner, body: { name: "FN_TEST" } }), 404);
  // WRITE round-trip
  const slaCreate = await req("POST", "/crm/sla/policies", { token: owner, body: { name: "FN_TEST_sla", appliesTo: "lead", priority: "high", firstResponseHours: 1, resolutionHours: 8 } });
  check("POST /crm/sla/policies create", slaCreate, 201);
  const slaId = slaCreate.body?.id;
  if (slaId != null) {
    check("PATCH /crm/sla/policies/:id", await req("PATCH", `/crm/sla/policies/${slaId}`, { token: owner, body: { firstResponseHours: 2 } }), 200);
    check("DELETE /crm/sla/policies/:id", await req("DELETE", `/crm/sla/policies/${slaId}`, { token: owner }), [200, 204]);
  }

  // =========================================================================
  // CRM TERRITORIES  (/crm/territories) — JwtAuthGuard auth-only
  // =========================================================================
  check("AUTH GET /crm/territories no-token", await req("GET", "/crm/territories"), 401);
  check("GET /crm/territories owner", await req("GET", "/crm/territories", { token: owner }), 200);
  check("GET /crm/territories member (auth-only)", await req("GET", "/crm/territories", { token: member }), 200);
  check("GET /crm/territories/:id 404", await req("GET", `/crm/territories/${FAKE}`, { token: owner }), 404);
  check("GET /crm/territories/:id 400 non-numeric", await req("GET", `/crm/territories/${NOTNUM}`, { token: owner }), 400);
  check("POST /crm/territories 400 empty body", await req("POST", "/crm/territories", { token: owner, body: {} }), 400);
  const terrCreate = await req("POST", "/crm/territories", { token: owner, body: { name: "FN_TEST_terr" } });
  check("POST /crm/territories create", terrCreate, 201);
  const terrId = terrCreate.body?.id;
  if (terrId != null) {
    check("GET /crm/territories/:id created", await req("GET", `/crm/territories/${terrId}`, { token: owner }), 200);
    check("PATCH /crm/territories/:id", await req("PATCH", `/crm/territories/${terrId}`, { token: owner, body: { description: "FN_TEST" } }), 200);
    check("DELETE /crm/territories/:id", await req("DELETE", `/crm/territories/${terrId}`, { token: owner }), [200, 204]);
  }

  // =========================================================================
  // CRM WEB-FORMS  (/crm/web-forms) — JwtAuthGuard auth-only
  // =========================================================================
  check("AUTH GET /crm/web-forms no-token", await req("GET", "/crm/web-forms"), 401);
  check("GET /crm/web-forms owner", await req("GET", "/crm/web-forms", { token: owner }), 200);
  check("GET /crm/web-forms member (auth-only)", await req("GET", "/crm/web-forms", { token: member }), 200);
  check("GET /crm/web-forms/:id 404", await req("GET", `/crm/web-forms/${FAKE}`, { token: owner }), 404);
  check("POST /crm/web-forms 400 empty body", await req("POST", "/crm/web-forms", { token: owner, body: {} }), 400);
  const formCreate = await req("POST", "/crm/web-forms", { token: owner, body: { name: "FN_TEST_form", fields: [] } });
  check("POST /crm/web-forms create", formCreate, 201);
  const formId = formCreate.body?.id;
  if (formId != null) {
    check("GET /crm/web-forms/:id created", await req("GET", `/crm/web-forms/${formId}`, { token: owner }), 200);
    check("PATCH /crm/web-forms/:id", await req("PATCH", `/crm/web-forms/${formId}`, { token: owner, body: { description: "FN_TEST" } }), 200);
    check("DELETE /crm/web-forms/:id", await req("DELETE", `/crm/web-forms/${formId}`, { token: owner }), [200, 204]);
  }

  // =========================================================================
  // CRM RULES  (/crm/{assignment,scoring,email}-*) — writes gated manage crm:*
  // =========================================================================
  check("AUTH GET /crm/assignment-rules no-token", await req("GET", "/crm/assignment-rules"), 401);
  check("GET /crm/assignment-rules owner", await req("GET", "/crm/assignment-rules", { token: owner }), 200);
  check("GET /crm/scoring-rules owner", await req("GET", "/crm/scoring-rules", { token: owner }), 200);
  check("GET /crm/email-templates owner", await req("GET", "/crm/email-templates", { token: owner }), 200);
  check("GET /crm/assignment-rules member (auth-only)", await req("GET", "/crm/assignment-rules", { token: member }), 200);
  // RBAC negatives
  check("POST /crm/assignment-rules member RBAC", await req("POST", "/crm/assignment-rules", { token: member, body: { name: "FN_TEST", assignmentType: "round_robin" } }), 403);
  check("PATCH /crm/assignment-rules/reorder member RBAC", await req("PATCH", "/crm/assignment-rules/reorder", { token: member, body: { ruleIds: [1] } }), 403);
  check("POST /crm/scoring-rules member RBAC", await req("POST", "/crm/scoring-rules", { token: member, body: { field: "source", operator: "eq", value: "web", points: 10 } }), 403);
  check("POST /crm/email-templates member RBAC", await req("POST", "/crm/email-templates", { token: member, body: { name: "FN_TEST", subject: "s", body: "b" } }), 403);
  check("PATCH /crm/assignment-rules/:id 404 owner", await req("PATCH", `/crm/assignment-rules/${FAKE}`, { token: owner, body: { name: "FN_TEST" } }), 404);
  check("PATCH /crm/scoring-rules/:id 404 owner", await req("PATCH", `/crm/scoring-rules/${FAKE}`, { token: owner, body: { points: 5 } }), 404);
  check("PATCH /crm/email-templates/:id 404 owner", await req("PATCH", `/crm/email-templates/${FAKE}`, { token: owner, body: { name: "FN_TEST" } }), 404);
  // WRITE round-trips
  const arCreate = await req("POST", "/crm/assignment-rules", { token: owner, body: { name: "FN_TEST_ar", assignmentType: "round_robin", priority: 0, isActive: true } });
  check("POST /crm/assignment-rules create", arCreate, 201);
  const arId = arCreate.body?.id;
  if (arId != null) {
    check("PATCH /crm/assignment-rules/:id", await req("PATCH", `/crm/assignment-rules/${arId}`, { token: owner, body: { isActive: false } }), 200);
    check("PATCH /crm/assignment-rules/reorder owner", await req("PATCH", "/crm/assignment-rules/reorder", { token: owner, body: { ruleIds: [arId] } }), [200, 201]);
    check("DELETE /crm/assignment-rules/:id", await req("DELETE", `/crm/assignment-rules/${arId}`, { token: owner }), [200, 204]);
  }
  const srCreate = await req("POST", "/crm/scoring-rules", { token: owner, body: { field: "source", operator: "eq", value: "FN_TEST_web", points: 10 } });
  check("POST /crm/scoring-rules create", srCreate, 201);
  const srId = srCreate.body?.id;
  if (srId != null) {
    check("PATCH /crm/scoring-rules/:id", await req("PATCH", `/crm/scoring-rules/${srId}`, { token: owner, body: { points: 20 } }), 200);
    check("DELETE /crm/scoring-rules/:id", await req("DELETE", `/crm/scoring-rules/${srId}`, { token: owner }), [200, 204]);
  }
  const etCreate = await req("POST", "/crm/email-templates", { token: owner, body: { name: "FN_TEST_et", subject: "FN_TEST", body: "FN_TEST body" } });
  check("POST /crm/email-templates create", etCreate, 201);
  const etId = etCreate.body?.id;
  if (etId != null) {
    check("PATCH /crm/email-templates/:id", await req("PATCH", `/crm/email-templates/${etId}`, { token: owner, body: { subject: "FN_TEST2" } }), 200);
    check("DELETE /crm/email-templates/:id", await req("DELETE", `/crm/email-templates/${etId}`, { token: owner }), [200, 204]);
  }

  // =========================================================================
  // CRM DASHBOARDS  (/crm/{sales,support,customer-executive}-dashboard) auth-only
  // =========================================================================
  check("AUTH GET /crm/sales-dashboard no-token", await req("GET", "/crm/sales-dashboard"), 401);
  check("GET /crm/sales-dashboard owner", await req("GET", "/crm/sales-dashboard", { token: owner }), 200);
  check("GET /crm/support-dashboard owner", await req("GET", "/crm/support-dashboard", { token: owner }), 200);
  check("GET /crm/customer-executive owner", await req("GET", "/crm/customer-executive", { token: owner }), 200);
  check("GET /crm/sales-dashboard member (auth-only)", await req("GET", "/crm/sales-dashboard", { token: member }), 200);

  process.exit(report("crm-core") ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
