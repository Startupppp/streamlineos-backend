import { ORG, USERS, mint, req, check, report } from "./harness.mjs";

// admin-infra group: org, organization, branches, rbac, roles, dashboard,
// public, settings, search, cron, integrations-git, webhooks.
// Strategy: AUTH (no token -> 401 on protected), happy path (owner GET -> 200),
// RBAC negatives (low-priv -> 403), error paths (404/400), and safe write
// round-trips (FN_TEST_ prefixed rows created then deleted).

const FAKE_UUID = "00000000-0000-4000-8000-000000000000";
const FAKE_ID = 999999999;

const run = async () => {
  const owner = await mint("owner");
  const member = await mint("member");
  const salesRep = await mint("salesRep");

  // ---------------------------------------------------------------- AUTH (401)
  // Every JwtAuthGuard / AbilityGuard route must reject a missing token.
  const protectedRoutes = [
    ["GET", "/org/members"],
    ["GET", "/organization"],
    ["POST", "/organization"],
    ["GET", "/organization/profile"],
    ["GET", "/organization/members"],
    ["DELETE", "/organization/members/" + FAKE_UUID],
    ["GET", "/organization/invitations"],
    ["DELETE", "/organization/invitations"],
    ["GET", "/organization/settings"],
    ["PATCH", "/organization/settings"],
    ["GET", "/branches"],
    ["GET", "/branches/1"],
    ["PATCH", "/branches/1"],
    ["DELETE", "/branches/1"],
    ["GET", "/rbac/permissions"],
    ["GET", "/rbac/role-permissions?role=MEMBER"],
    ["POST", "/rbac/role-permissions"],
    ["GET", "/rbac/user-permissions"],
    ["GET", "/roles"],
    ["POST", "/roles"],
    ["GET", "/roles/templates"],
    ["GET", "/roles/1"],
    ["PATCH", "/roles/1"],
    ["DELETE", "/roles/1"],
    ["GET", "/dashboard/stats"],
    ["GET", "/dashboard/announcements"],
    ["POST", "/dashboard/announcements"],
    ["GET", "/settings/api-keys"],
    ["POST", "/settings/api-keys"],
    ["GET", "/settings/automations"],
    ["GET", "/settings/feature-flags"],
    ["GET", "/settings/integrations/git"],
    ["GET", "/search?q=test"],
    ["GET", "/webhooks"],
    ["POST", "/webhooks"],
    ["GET", "/webhooks/1"],
  ];
  for (const [m, p] of protectedRoutes) {
    check(`AUTH ${m} ${p}`, await req(m, p), 401);
  }

  // ------------------------------------------------------------------- ORG
  check("GET /org/members owner", await req("GET", "/org/members", { token: owner }), 200);
  check("GET /org/members member (auth-only)", await req("GET", "/org/members", { token: member }), 200);

  // ---------------------------------------------------------- ORGANIZATION
  const orgsRes = await req("GET", "/organization", { token: owner });
  check("GET /organization owner", orgsRes, 200);
  check("GET /organization member (auth-only)", await req("GET", "/organization", { token: member }), 200);

  check("GET /organization/profile owner", await req("GET", "/organization/profile", { token: owner }), 200);
  check("GET /organization/members owner", await req("GET", "/organization/members", { token: owner }), 200);
  check("GET /organization/members?page=1&limit=5 owner", await req("GET", "/organization/members?page=1&limit=5", { token: owner }), 200);

  const settingsRes = await req("GET", "/organization/settings", { token: owner });
  check("GET /organization/settings owner", settingsRes, 200);
  const orgSlug = settingsRes.body?.slug ?? null;

  check("GET /organization/invitations owner (@CheckAbility manage settings)", await req("GET", "/organization/invitations", { token: owner }), 200);
  check("GET /organization/invitations member RBAC-403", await req("GET", "/organization/invitations", { token: member }), 403);

  // POST /organization: create org is not cleanly reversible -> skip persist.
  // Owner passes ability then fails Zod (empty body) -> 400 (no row created).
  check("POST /organization owner empty-body 400", await req("POST", "/organization", { token: owner, body: {} }), 400);
  // Member blocked by AbilityGuard before validation -> 403.
  check("POST /organization member RBAC-403", await req("POST", "/organization", { token: member, body: { name: "FN_TEST_org", slug: "fn-test-org" } }), 403);

  // DELETE /organization/members/:id — owner removing self -> 400 (guard, no delete).
  check("DELETE /organization/members/self owner 400", await req("DELETE", "/organization/members/" + USERS.owner.sub, { token: owner }), 400);
  check("DELETE /organization/members/:id member RBAC-403", await req("DELETE", "/organization/members/" + FAKE_UUID, { token: member }), 403);

  // DELETE /organization/invitations — owner empty body -> Zod 400; member -> 403 (AbilityGuard).
  check("DELETE /organization/invitations owner empty-body 400", await req("DELETE", "/organization/invitations", { token: owner, body: {} }), 400);
  check("DELETE /organization/invitations member RBAC-403", await req("DELETE", "/organization/invitations", { token: member, body: { invitationId: "x" } }), 403);

  // PATCH /organization/settings — member valid body hits inline ability -> 403 (no mutation);
  // owner invalid enum -> Zod 400 (no mutation).
  check("PATCH /organization/settings member RBAC-403", await req("PATCH", "/organization/settings", { token: member, body: {} }), 403);
  check("PATCH /organization/settings owner bad-currency 400", await req("PATCH", "/organization/settings", { token: owner, body: { currency: "XXX" } }), 400);

  // ------------------------------------------------------------------ BRANCHES
  const branchesRes = await req("GET", "/branches", { token: owner });
  check("GET /branches owner", branchesRes, 200);
  check("GET /branches member (auth-only)", await req("GET", "/branches", { token: member }), 200);
  const firstBranchId = Array.isArray(branchesRes.body) && branchesRes.body[0] ? branchesRes.body[0].id : null;

  if (firstBranchId != null) {
    check("GET /branches/:id owner", await req("GET", "/branches/" + firstBranchId, { token: owner }), 200);
  }
  check("GET /branches/:id non-existent 404", await req("GET", "/branches/" + FAKE_ID, { token: owner }), 404);
  check("GET /branches/:id non-numeric 400", await req("GET", "/branches/abc", { token: owner }), 400);

  // PATCH/DELETE branches are role-gated to ["HR","CEO"]; OWNER now passes via
  // hasRoleOrPrivileged, but member stays 403. Assert the member deny; skip owner
  // mutation to avoid altering real branch rows.
  check("PATCH /branches/:id member role-gate 403", await req("PATCH", "/branches/" + (firstBranchId ?? 1), { token: member, body: { name: "FN_TEST_branch" } }), 403);
  check("PATCH /branches/:id non-numeric 400", await req("PATCH", "/branches/abc", { token: owner, body: { name: "x" } }), 400);
  check("DELETE /branches/:id member role-gate 403", await req("DELETE", "/branches/" + (firstBranchId ?? 1), { token: member }), 403);

  // ---------------------------------------------------------------------- RBAC
  check("GET /rbac/permissions owner", await req("GET", "/rbac/permissions", { token: owner }), 200);
  check("GET /rbac/permissions member (auth-only)", await req("GET", "/rbac/permissions", { token: member }), 200);
  check("GET /rbac/role-permissions?role=MEMBER owner", await req("GET", "/rbac/role-permissions?role=MEMBER", { token: owner }), 200);
  check("GET /rbac/role-permissions missing-role 400", await req("GET", "/rbac/role-permissions", { token: owner }), 400);
  check("GET /rbac/user-permissions owner", await req("GET", "/rbac/user-permissions", { token: owner }), 200);
  // POST role-permissions: real insert, no clean delete -> skip persist.
  check("POST /rbac/role-permissions member RBAC-403", await req("POST", "/rbac/role-permissions", { token: member, body: { role: "MEMBER", permissionId: 1 } }), 403);
  check("POST /rbac/role-permissions owner empty-body 400", await req("POST", "/rbac/role-permissions", { token: owner, body: {} }), 400);

  // --------------------------------------------------------------------- ROLES
  check("GET /roles owner", await req("GET", "/roles", { token: owner }), 200);
  check("GET /roles member (auth-only)", await req("GET", "/roles", { token: member }), 200);
  const templatesRes = await req("GET", "/roles/templates", { token: owner });
  check("GET /roles/templates owner", templatesRes, 200);
  const templateId = Array.isArray(templatesRes.body) && templatesRes.body[0] ? templatesRes.body[0].id : null;

  check("GET /roles/:id non-numeric 400", await req("GET", "/roles/abc", { token: owner }), 400);
  check("GET /roles/:id non-existent 404", await req("GET", "/roles/" + FAKE_ID, { token: owner }), 404);
  // createRole requires manage-all (owner ok, member 403).
  check("POST /roles member RBAC-403", await req("POST", "/roles", { token: member, body: { name: "FN_TEST_role", slug: "FN_TEST_ROLE", permissions: [] } }), 403);
  check("POST /roles owner empty-body 400", await req("POST", "/roles", { token: owner, body: {} }), 400);

  // WRITE round-trip: create role -> GET -> PATCH -> DELETE.
  let createdRoleId = null;
  try {
    const createRole = await req("POST", "/roles", { token: owner, body: { name: "FN_TEST_role", slug: "FN_TEST_ROLE", permissions: [] } });
    check("POST /roles owner create 201/200", createRole, [200, 201]);
    createdRoleId = createRole.body?.id ?? null;
    if (createdRoleId != null) {
      check("GET /roles/:id owner (created)", await req("GET", "/roles/" + createdRoleId, { token: owner }), 200);
      check("PATCH /roles/:id owner", await req("PATCH", "/roles/" + createdRoleId, { token: owner, body: { name: "FN_TEST_role2" } }), 200);
      check("PATCH /roles/:id member RBAC-403", await req("PATCH", "/roles/" + createdRoleId, { token: member, body: { name: "nope" } }), 403);
    }
  } finally {
    if (createdRoleId != null) {
      check("DELETE /roles/:id owner cleanup", await req("DELETE", "/roles/" + createdRoleId, { token: owner }), 200);
    }
  }

  // WRITE round-trip: clone template -> DELETE.
  if (templateId != null) {
    let clonedRoleId = null;
    try {
      const clone = await req("POST", "/roles/templates", { token: owner, body: { templateId, name: "FN_TEST_clone", slug: "FN_TEST_CLONE" } });
      check("POST /roles/templates owner clone 200/201", clone, [200, 201]);
      clonedRoleId = clone.body?.id ?? null;
    } finally {
      if (clonedRoleId != null) {
        check("DELETE /roles/:id owner clone cleanup", await req("DELETE", "/roles/" + clonedRoleId, { token: owner }), 200);
      }
    }
    check("POST /roles/templates member RBAC-403", await req("POST", "/roles/templates", { token: member, body: { templateId } }), 403);
  }

  // ----------------------------------------------------------------- DASHBOARD
  // Open GETs (auth-only) -> 200 for owner. branch-overview excludes OWNER (403).
  const dashOpen = [
    "active-sprint", "announcements", "birthdays", "leaves-today", "manager",
    "my-leave-balance", "pending-requests", "personal", "recent-activity",
    "recent-projects", "role-stats", "stats", "team-attendance",
    "team-availability", "today-activities", "upcoming-holidays", "upcoming-leaves",
  ];
  for (const seg of dashOpen) {
    check(`GET /dashboard/${seg} owner`, await req("GET", "/dashboard/" + seg, { token: owner }), 200);
  }
  check("GET /dashboard/my-issues owner", await req("GET", "/dashboard/my-issues?userId=" + USERS.owner.sub, { token: owner }), 200);
  check("GET /dashboard/my-issues missing-userId 400", await req("GET", "/dashboard/my-issues", { token: owner }), 400);
  // executive: OWNER allowed -> 200; member -> 403.
  check("GET /dashboard/executive owner", await req("GET", "/dashboard/executive", { token: owner }), 200);
  check("GET /dashboard/executive member 403", await req("GET", "/dashboard/executive", { token: member }), 403);
  // pending-approvals: owner can approve hr:leaves -> 200; member -> 403.
  check("GET /dashboard/pending-approvals owner", await req("GET", "/dashboard/pending-approvals", { token: owner }), 200);
  check("GET /dashboard/pending-approvals member 403", await req("GET", "/dashboard/pending-approvals", { token: member }), 403);
  // branch-overview: inline role gate now honors isOrgOwner via hasRoleOrPrivileged — OWNER allowed -> 200; member still 403.
  check("GET /dashboard/branch-overview owner (privileged via isOrgOwner) 200", await req("GET", "/dashboard/branch-overview", { token: owner }), 200);
  check("GET /dashboard/branch-overview member 403", await req("GET", "/dashboard/branch-overview", { token: member }), 403);
  // member can read an open dashboard GET (not over-gated).
  check("GET /dashboard/stats member (auth-only)", await req("GET", "/dashboard/stats", { token: member }), 200);
  // announcements write: role-gated to CEO/HR/ADMIN; member stays 403 (owner now passes via privileged); skip persist.
  check("POST /dashboard/announcements member role-gate 403", await req("POST", "/dashboard/announcements", { token: member, body: { content: "FN_TEST_announce" } }), 403);
  check("DELETE /dashboard/announcements member role-gate 403", await req("DELETE", "/dashboard/announcements?id=1", { token: member }), 403);

  // -------------------------------------------------------------------- SEARCH
  check("GET /search owner", await req("GET", "/search?q=test", { token: owner }), 200);
  check("GET /search member (auth-only)", await req("GET", "/search?q=test", { token: member }), 200);
  check("GET /search too-short 400", await req("GET", "/search?q=a", { token: owner }), 400);

  // ------------------------------------------------------------------ SETTINGS
  // Open (no @CheckAbility, no internal gate).
  check("GET /settings/feature-flags owner", await req("GET", "/settings/feature-flags", { token: owner }), 200);
  check("GET /settings/feature-flags member (open)", await req("GET", "/settings/feature-flags", { token: member }), 200);
  // Internally gated (manage settings) though no @CheckAbility decorator.
  check("GET /settings/ai-usage owner", await req("GET", "/settings/ai-usage", { token: owner }), 200);
  check("GET /settings/ai-usage member internal-403", await req("GET", "/settings/ai-usage", { token: member }), 403);
  check("GET /settings/api-keys owner", await req("GET", "/settings/api-keys", { token: owner }), 200);
  check("GET /settings/api-keys member internal-403", await req("GET", "/settings/api-keys", { token: member }), 403);
  // @CheckAbility gated.
  check("GET /settings/automations owner", await req("GET", "/settings/automations", { token: owner }), 200);
  check("GET /settings/automations member RBAC-403", await req("GET", "/settings/automations", { token: member }), 403);
  check("GET /settings/automations/:id non-existent 404", await req("GET", "/settings/automations/" + FAKE_ID, { token: owner }), 404);
  check("GET /settings/automations/:id non-numeric 400", await req("GET", "/settings/automations/abc", { token: owner }), 400);
  check("GET /settings/automations/:id/runs non-existent 404", await req("GET", "/settings/automations/" + FAKE_ID + "/runs", { token: owner }), 404);
  check("GET /settings/custom-fields owner", await req("GET", "/settings/custom-fields", { token: owner }), 200);
  check("GET /settings/custom-fields member RBAC-403", await req("GET", "/settings/custom-fields", { token: member }), 403);
  check("GET /settings/integrations/git owner", await req("GET", "/settings/integrations/git", { token: owner }), 200);
  check("GET /settings/integrations/git member RBAC-403", await req("GET", "/settings/integrations/git", { token: member }), 403);
  // feature-flag PATCH internally gated.
  check("PATCH /settings/feature-flags member internal-403", await req("PATCH", "/settings/feature-flags", { token: member, body: { flag: "aiChat", enabled: true } }), 403);
  // user-role POST: real RBAC mutation -> skip persist; member valid body -> 403, owner empty -> 400.
  check("POST /settings/users/:id/role member internal-403", await req("POST", "/settings/users/" + FAKE_UUID + "/role", { token: member, body: { role: "MEMBER" } }), 403);
  check("POST /settings/users/:id/role owner empty-body 400", await req("POST", "/settings/users/" + FAKE_UUID + "/role", { token: owner, body: {} }), 400);
  // RBAC negatives on @CheckAbility writes.
  check("POST /settings/automations member RBAC-403", await req("POST", "/settings/automations", { token: member, body: { name: "x", triggerEvent: "lead.created", actions: [{ type: "notify_all", config: { title: "t", message: "m" } }] } }), 403);
  check("POST /settings/custom-fields member RBAC-403", await req("POST", "/settings/custom-fields", { token: member, body: { entityType: "lead", name: "fn_x", label: "X" } }), 403);
  check("POST /settings/integrations/git member RBAC-403", await req("POST", "/settings/integrations/git", { token: member, body: { provider: "github", repoUrl: "https://github.com/x/y" } }), 403);
  check("POST /settings/api-keys member internal-403", await req("POST", "/settings/api-keys", { token: member, body: { name: "x", scopes: [] } }), 403);
  // Owner malformed write bodies -> 400 (no persist).
  check("POST /settings/automations owner empty-body 400", await req("POST", "/settings/automations", { token: owner, body: {} }), 400);
  check("POST /settings/custom-fields owner bad-name 400", await req("POST", "/settings/custom-fields", { token: owner, body: { entityType: "lead", name: "BadName", label: "X" } }), 400);

  // WRITE round-trip: automation create -> GET -> PATCH -> DELETE.
  let ruleId = null;
  try {
    const create = await req("POST", "/settings/automations", { token: owner, body: { name: "FN_TEST_automation", triggerEvent: "lead.created", conditions: [], actions: [{ type: "notify_all", config: { title: "FN_TEST", message: "FN_TEST" } }], isEnabled: false } });
    check("POST /settings/automations owner create 201", create, [200, 201]);
    ruleId = create.body?.id ?? null;
    if (ruleId != null) {
      check("GET /settings/automations/:id owner (created)", await req("GET", "/settings/automations/" + ruleId, { token: owner }), 200);
      check("GET /settings/automations/:id/runs owner (created)", await req("GET", "/settings/automations/" + ruleId + "/runs", { token: owner }), 200);
      check("PATCH /settings/automations/:id owner", await req("PATCH", "/settings/automations/" + ruleId, { token: owner, body: { isEnabled: true } }), 200);
    }
  } finally {
    if (ruleId != null) {
      check("DELETE /settings/automations/:id owner cleanup", await req("DELETE", "/settings/automations/" + ruleId, { token: owner }), 200);
    }
  }

  // WRITE round-trip: custom field create -> PATCH -> DELETE.
  let fieldId = null;
  try {
    const create = await req("POST", "/settings/custom-fields", { token: owner, body: { entityType: "lead", name: "fn_test_field", label: "FN_TEST", fieldType: "text" } });
    check("POST /settings/custom-fields owner create 201", create, [200, 201]);
    fieldId = create.body?.field?.id ?? null;
    if (fieldId != null) {
      check("PATCH /settings/custom-fields/:id owner", await req("PATCH", "/settings/custom-fields/" + fieldId, { token: owner, body: { label: "FN_TEST2" } }), 200);
    }
  } finally {
    if (fieldId != null) {
      check("DELETE /settings/custom-fields/:id owner cleanup", await req("DELETE", "/settings/custom-fields/" + fieldId, { token: owner }), 200);
    }
  }

  // WRITE round-trip: git connection create -> PATCH -> DELETE.
  let connId = null;
  try {
    const create = await req("POST", "/settings/integrations/git", { token: owner, body: { provider: "github", repoUrl: "https://github.com/fn-test/fn-test-repo", repoName: "FN_TEST_repo" } });
    check("POST /settings/integrations/git owner create 201", create, [200, 201]);
    connId = create.body?.id ?? null;
    if (connId != null) {
      check("PATCH /settings/integrations/git/:id owner", await req("PATCH", "/settings/integrations/git/" + connId, { token: owner, body: { isActive: false } }), 200);
    }
  } finally {
    if (connId != null) {
      check("DELETE /settings/integrations/git/:id owner cleanup", await req("DELETE", "/settings/integrations/git/" + connId, { token: owner }), 200);
    }
  }

  // WRITE round-trip: api key create -> revoke (DELETE).
  let keyId = null;
  try {
    const create = await req("POST", "/settings/api-keys", { token: owner, body: { name: "FN_TEST_key", scopes: ["leads:read"] } });
    check("POST /settings/api-keys owner create 201", create, [200, 201]);
    keyId = create.body?.id ?? null;
  } finally {
    if (keyId != null) {
      check("DELETE /settings/api-keys/:id owner revoke cleanup", await req("DELETE", "/settings/api-keys/" + keyId, { token: owner }), 200);
    }
  }
  check("DELETE /settings/api-keys/:id non-existent 404", await req("DELETE", "/settings/api-keys/" + FAKE_UUID, { token: owner }), 404);

  // ------------------------------------------------------------------ WEBHOOKS
  check("GET /webhooks owner", await req("GET", "/webhooks", { token: owner }), 200);
  check("GET /webhooks member (auth-only list)", await req("GET", "/webhooks", { token: member }), 200);
  check("GET /webhooks/:id non-existent 404", await req("GET", "/webhooks/" + FAKE_ID, { token: owner }), 404);
  check("GET /webhooks/:id non-numeric 400", await req("GET", "/webhooks/abc", { token: owner }), 400);
  check("POST /webhooks member RBAC-403", await req("POST", "/webhooks", { token: member, body: { url: "https://example.com/fn" } }), 403);
  check("POST /webhooks owner bad-url 400", await req("POST", "/webhooks", { token: owner, body: { url: "not-a-url" } }), 400);

  let webhookId = null;
  try {
    const create = await req("POST", "/webhooks", { token: owner, body: { url: "https://example.com/fn_test_hook", description: "FN_TEST_webhook", events: ["lead.created"] } });
    check("POST /webhooks owner create 201", create, [200, 201]);
    webhookId = create.body?.id ?? null;
    if (webhookId != null) {
      check("GET /webhooks/:id owner (created)", await req("GET", "/webhooks/" + webhookId, { token: owner }), 200);
      check("PATCH /webhooks/:id owner", await req("PATCH", "/webhooks/" + webhookId, { token: owner, body: { description: "FN_TEST_webhook_upd" } }), 200);
      check("PATCH /webhooks/:id member RBAC-403", await req("PATCH", "/webhooks/" + webhookId, { token: member, body: { description: "nope" } }), 403);
    }
  } finally {
    if (webhookId != null) {
      check("DELETE /webhooks/:id owner cleanup", await req("DELETE", "/webhooks/" + webhookId, { token: owner }), 200);
    }
  }

  // --------------------------------------------------------------------- CRON
  // @Public but secret-gated. Unknown secret -> 401, or 503 if CRON_SECRET unset.
  const cronSegs = ["auto-checkout", "monthly-leave-reset", "daily-notifications", "holiday-notifications"];
  for (const seg of cronSegs) {
    check(`GET /cron/${seg} no-secret`, await req("GET", "/cron/" + seg), [401, 503]);
    check(`POST /cron/${seg} no-secret`, await req("POST", "/cron/" + seg), [401, 503]);
  }
  // If the running backend has CRON_SECRET configured, exercise the happy path.
  if (process.env.CRON_SECRET) {
    const auth = { headers: {} };
    const r = await fetch((process.env.FN_BASE_URL ?? "http://localhost:1500") + "/cron/auto-checkout", { headers: { Authorization: "Bearer " + process.env.CRON_SECRET } });
    check("GET /cron/auto-checkout valid-secret", { status: r.status, body: null }, 200);
  }

  // -------------------------------------------------------- INTEGRATIONS-GIT
  // @Public HMAC webhook — always acks 200 regardless of signature (errors swallowed).
  check("POST /integrations/git/webhook (public ack)", await req("POST", "/integrations/git/webhook", { body: { test: "FN_TEST" } }), 200);
  check("POST /integrations/git/webhook?connectionId=999 (public ack)", await req("POST", "/integrations/git/webhook?connectionId=999", { body: {} }), 200);

  // ------------------------------------------------------------------- PUBLIC
  // @Public — no 401. Token/slug-driven; missing data -> 404. Real org -> 200.
  check("GET /public/roadmap?org=ORG", await req("GET", "/public/roadmap?org=" + ORG), 200);
  check("GET /public/roadmap missing-org 400", await req("GET", "/public/roadmap"), 400);
  check("GET /public/roadmap?org=fake 404", await req("GET", "/public/roadmap?org=" + FAKE_UUID), 404);
  check("GET /public/kb?org=ORG", await req("GET", "/public/kb?org=" + ORG), 200);
  check("GET /public/kb missing-org 400", await req("GET", "/public/kb"), 400);
  check("GET /public/kb/:slug?org=ORG non-existent 404", await req("GET", "/public/kb/fn-test-missing?org=" + ORG), 404);
  // FIXED: recruitment/hiring tables now exist in the live DB. These formerly 500'd
  // on schema drift (missing tracking_token / acceptance_token / hiring_flow_id /
  // is_internal columns); they now correctly resolve a missing token to 404.
  check("GET /public/application-status/:token fake 404", await req("GET", "/public/application-status/fn-test-fake-token"), 404);
  check("GET /public/offer/:token fake 404", await req("GET", "/public/offer/fn-test-fake-token"), 404);
  check("PATCH /public/offer/:token/respond valid-body fake 404", await req("PATCH", "/public/offer/fn-test-fake-token/respond", { body: { action: "decline" } }), 404);
  check("GET /public/interview-booking/:token fake 404", await req("GET", "/public/interview-booking/fn-test-fake-token"), 404);
  check("GET /public/lead-form/:token fake 404", await req("GET", "/public/lead-form/fn-test-fake-token"), 404);
  check("GET /public/nps/:token fake 404", await req("GET", "/public/nps/fn-test-fake-token"), 404);

  if (orgSlug) {
    const jobsRes = await req("GET", "/public/careers/" + orgSlug + "/jobs");
    check("GET /public/careers/:slug/jobs real-slug 200", jobsRes, 200);
    check("GET /public/careers/:slug/jobs/:id non-existent 404", await req("GET", "/public/careers/" + orgSlug + "/jobs/" + FAKE_ID), 404);
    check("GET /public/careers/:slug/jobs/:id non-numeric 400", await req("GET", "/public/careers/" + orgSlug + "/jobs/abc"), 400);
  }
  check("GET /public/careers/:slug/jobs fake-slug 404", await req("GET", "/public/careers/fn-test-missing-org/jobs"), 404);

  // Public POSTs — validate without persisting real data.
  check("POST /public/careers/:slug/jobs/:id/apply bad-body 400", await req("POST", "/public/careers/fn-test/jobs/1/apply", { body: {} }), 400);
  check("POST /public/intake/:projectId bad-body 400", await req("POST", "/public/intake/1", { body: {} }), 400);
  check("POST /public/nps/:token bad-body 400", await req("POST", "/public/nps/fn-test-token", { body: { score: 99 } }), 400);
  check("POST /public/roadmap/vote bad-body 400", await req("POST", "/public/roadmap/vote?org=" + ORG, { body: {} }), 400);
  check("POST /public/roadmap/feedback bad-body 400", await req("POST", "/public/roadmap/feedback?org=" + ORG, { body: {} }), 400);
  check("PATCH /public/offer/:token/respond bad-body 400", await req("PATCH", "/public/offer/fn-test-token/respond", { body: { action: "bogus" } }), 400);
  check("POST /public/kb/:slug/feedback bad-body 400", await req("POST", "/public/kb/fn-test-slug/feedback?org=" + ORG, { body: {} }), 400);
};

run()
  .then(() => process.exit(report("admin-infra") ? 0 : 1))
  .catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
