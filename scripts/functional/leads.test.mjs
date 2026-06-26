import { mint, req, check, report, USERS } from "./harness.mjs";

// Non-existent numeric ids (leads.id is a serial int)
const NX = 99999999;
const NX2 = 99999998;
const tag = () => `FN_TEST_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;

async function main() {
  const owner = await mint("owner");
  const member = await mint("member");
  const salesRep = await mint("salesRep");
  // Tokens that satisfy the inline role-string gates on merge/distribute.
  const ceo = await mint("owner", { role: "CEO", isOrgOwner: false, permissions: [] });
  const hr = await mint("owner", { role: "HR", isOrgOwner: false, permissions: [] });

  // ---------------------------------------------------------------------------
  // AUTH: protected routes with NO token -> 401 (one per controller; guard is
  // declared at class level so a single hit per controller proves the guard).
  // ---------------------------------------------------------------------------
  check("AUTH no-token GET /leads -> 401", await req("GET", "/leads"), 401);
  check("AUTH no-token GET /leads/analytics -> 401", await req("GET", "/leads/analytics"), 401);
  check("AUTH no-token GET /leads/import/1 -> 401", await req("GET", "/leads/import/1"), 401);
  check("AUTH no-token GET /leads/1/activities -> 401", await req("GET", "/leads/1/activities"), 401);
  // Ingest is ApiKeyGuard (X-API-Key), not JWT — missing key -> 401.
  check("AUTH no-key POST /leads/ingest -> 401", await req("POST", "/leads/ingest", { body: { name: "x" } }), 401);

  // ---------------------------------------------------------------------------
  // HAPPY PATH — owner GETs. LeadsController GET / is @CheckAbility(read).
  // ---------------------------------------------------------------------------
  const list = await req("GET", "/leads", { token: owner });
  check("GET /leads owner -> 200", list, 200);
  const realLeadId = list.body?.leads?.[0]?.id;

  // Reports/exports controller (auth-only GETs).
  for (const p of [
    "analytics",
    "dashboard-metrics",
    "source-report",
    "sales-leaderboard",
    "sales-team-capacity",
    "sla-alerts",
    "follow-ups",
    "duplicates",
    "check-duplicates",
    "export",
  ]) {
    check(`GET /leads/${p} owner -> 200`, await req("GET", `/leads/${p}`, { token: owner }), 200);
  }
  // unverified is @CheckAbility(read, crm:leads).
  check("GET /leads/unverified owner -> 200", await req("GET", "/leads/unverified", { token: owner }), 200);

  // board/stats are auth-only (AbilityGuard present but no @CheckAbility).
  check("GET /leads/board owner -> 200", await req("GET", "/leads/board", { token: owner }), 200);
  check("GET /leads/stats owner -> 200", await req("GET", "/leads/stats", { token: owner }), 200);

  // Detail GETs against a real lead.
  if (realLeadId != null) {
    check("GET /leads/:id owner -> 200", await req("GET", `/leads/${realLeadId}`, { token: owner }), 200);
    check("GET /leads/:id/activities owner -> 200", await req("GET", `/leads/${realLeadId}/activities`, { token: owner }), 200);
    check("GET /leads/:id/timeline owner -> 200", await req("GET", `/leads/${realLeadId}/timeline`, { token: owner }), 200);
    check("GET /leads/:id/score-explanation owner -> 200", await req("GET", `/leads/${realLeadId}/score-explanation`, { token: owner }), 200);
  }

  // ---------------------------------------------------------------------------
  // RBAC NEGATIVE — read-gated route denies low-priv tokens (no permissions).
  // ---------------------------------------------------------------------------
  check("RBAC GET /leads member -> 403", await req("GET", "/leads", { token: member }), 403);
  check("RBAC GET /leads salesRep -> 403", await req("GET", "/leads", { token: salesRep }), 403);
  check("RBAC GET /leads/unverified member -> 403", await req("GET", "/leads/unverified", { token: member }), 403);

  // RBAC NOT over-gated — auth-only routes must allow a plain member (200).
  check("RBAC GET /leads/board member -> 200", await req("GET", "/leads/board", { token: member }), 200);
  check("RBAC GET /leads/stats member -> 200", await req("GET", "/leads/stats", { token: member }), 200);
  check("RBAC GET /leads/analytics member -> 200", await req("GET", "/leads/analytics", { token: member }), 200);
  if (realLeadId != null) {
    check("RBAC GET /leads/:id/activities member -> 200", await req("GET", `/leads/${realLeadId}/activities`, { token: member }), 200);
  }

  // ---------------------------------------------------------------------------
  // ERROR PATHS — bad ids.
  // ---------------------------------------------------------------------------
  check("GET /leads/abc (non-numeric) -> 400", await req("GET", "/leads/abc", { token: owner }), 400);
  check("GET /leads/:NX -> 404", await req("GET", `/leads/${NX}`, { token: owner }), 404);
  check("GET /leads/import/:NX -> 404", await req("GET", `/leads/import/${NX}`, { token: owner }), 404);
  check("PATCH /leads/:NX/custom-data -> 404", await req("PATCH", `/leads/${NX}/custom-data`, { token: owner, body: { customData: {} } }), 404);
  // changeStatus on a missing lead returns stale_or_missing -> ConflictException (409).
  check("PATCH /leads/:NX/status -> 409", await req("PATCH", `/leads/${NX}/status`, { token: owner, body: { status: "NEW" } }), 409);
  check("PATCH /leads/:NX/verify -> 404", await req("PATCH", `/leads/${NX}/verify`, { token: owner, body: {} }), 404);
  check("PATCH /leads/:NX/reject -> 404", await req("PATCH", `/leads/${NX}/reject`, { token: owner, body: {} }), 404);
  check("PATCH /leads/:NX/assign -> 404", await req("PATCH", `/leads/${NX}/assign`, { token: owner, body: { assignedToId: USERS.owner.sub } }), 404);
  check("PATCH /leads/:NX/self-assign -> 404", await req("PATCH", `/leads/${NX}/self-assign`, { token: owner }), 404);
  check("PATCH /leads/:NX (update) -> 404", await req("PATCH", `/leads/${NX}`, { token: owner, body: { notes: "x" } }), 404);
  check("POST /leads/:NX/merge keep-not-found -> 404", await req("POST", `/leads/${NX}/merge`, { token: owner, body: { mergeLeadId: NX2 } }), 404);

  // ---------------------------------------------------------------------------
  // VALIDATION — malformed/empty body -> 400 (ZodError -> global filter 400).
  // None of these persist a row.
  // ---------------------------------------------------------------------------
  check("POST /leads empty body -> 400", await req("POST", "/leads", { token: owner, body: {} }), 400);
  check("PATCH /leads/bulk empty body -> 400", await req("PATCH", "/leads/bulk", { token: owner, body: {} }), 400);
  check("POST /leads/import empty leads[] -> 400", await req("POST", "/leads/import", { token: owner, body: { leads: [] } }), 400);
  if (realLeadId != null) {
    check("POST /leads/:id/activities empty body -> 400", await req("POST", `/leads/${realLeadId}/activities`, { token: owner, body: {} }), 400);
  }

  // ---------------------------------------------------------------------------
  // RBAC NEGATIVE — WRITE routes deny low-priv tokens.
  // @CheckAbility(update|create|delete, crm:leads): member -> 403.
  // ---------------------------------------------------------------------------
  check("RBAC PATCH /leads/bulk member -> 403", await req("PATCH", "/leads/bulk", { token: member, body: { leadIds: [1], update: { status: "NEW" } } }), 403);
  check("RBAC DELETE /leads/bulk member -> 403", await req("DELETE", "/leads/bulk", { token: member, body: { leadIds: [1] } }), 403);
  check("RBAC POST /leads/import member -> 403", await req("POST", "/leads/import", { token: member, body: { leads: [{ name: "x" }] } }), 403);
  check("RBAC DELETE /leads/:NX member -> 403", await req("DELETE", `/leads/${NX}`, { token: member }), 403);
  check("RBAC PATCH /leads/:NX/verify member -> 403", await req("PATCH", `/leads/${NX}/verify`, { token: member, body: {} }), 403);
  check("RBAC PATCH /leads/:NX/reject member -> 403", await req("PATCH", `/leads/${NX}/reject`, { token: member, body: {} }), 403);

  // Inline role-string gates (merge/distribute). member -> 403.
  check("RBAC POST /leads/merge member -> 403", await req("POST", "/leads/merge", { token: member, body: { winnerId: 1, loserId: 2 } }), 403);
  check("RBAC POST /leads/distribute member -> 403", await req("POST", "/leads/distribute", { token: member, body: { leadIds: [1] } }), 403);
  // NOTE (recorded as a bug): the org OWNER role is NOT in MERGE_ROLES/DISTRIBUTE_ROLES,
  // so the org owner is also denied (403) on these two endpoints.
  check("OBSERVED POST /leads/merge owner -> 403 (OWNER excluded from gate)", await req("POST", "/leads/merge", { token: owner, body: { winnerId: 1, loserId: 2 } }), 403);
  check("OBSERVED POST /leads/distribute owner -> 403 (OWNER excluded from gate)", await req("POST", "/leads/distribute", { token: owner, body: { leadIds: [1] } }), 403);

  // Role-gate PASS + non-destructive paths.
  // CEO self-merge short-circuits (winnerId===loserId) before any DB write -> 400.
  check("POST /leads/merge CEO self-merge -> 400", await req("POST", "/leads/merge", { token: ceo, body: { winnerId: 1, loserId: 1 } }), 400);
  // HR distribute with a bogus lead id touches no real lead -> no_sales (400) or no_leads (404).
  check("POST /leads/distribute HR bogus lead -> 400|404", await req("POST", "/leads/distribute", { token: hr, body: { leadIds: [NX] } }), [400, 404]);
  // CheckAbility-gated merge/import malformed body still validates (owner passes ability, Zod -> 400).
  check("POST /leads/merge CEO empty body -> 400", await req("POST", "/leads/merge", { token: ceo, body: {} }), 400);

  // ---------------------------------------------------------------------------
  // WRITES — full lifecycle on clearly-marked throwaway rows, cleaned up after.
  // ---------------------------------------------------------------------------
  const c1 = await req("POST", "/leads", { token: owner, body: { name: `${tag()}_main`, source: "other", priority: "WARM" } });
  check("POST /leads create main -> 201", c1, 201);
  const id1 = c1.body?.id;

  const c2 = await req("POST", "/leads", { token: owner, body: { name: `${tag()}_loser` } });
  check("POST /leads create loser -> 201", c2, 201);
  const id2 = c2.body?.id;

  const c3 = await req("POST", "/leads", { token: owner, body: { name: `${tag()}_bulkdel` } });
  check("POST /leads create bulkdel -> 201", c3, 201);
  const id3 = c3.body?.id;

  if (id1 != null) {
    check("GET created lead -> 200", await req("GET", `/leads/${id1}`, { token: owner }), 200);
    check("POST /leads/:id/activities valid -> 201", await req("POST", `/leads/${id1}/activities`, { token: owner, body: { type: "call", date: new Date().toISOString(), notes: "FN_TEST activity" } }), 201);
    check("GET /leads/:id/activities after add -> 200", await req("GET", `/leads/${id1}/activities`, { token: owner }), 200);
    check("PATCH /leads/:id/custom-data -> 200", await req("PATCH", `/leads/${id1}/custom-data`, { token: owner, body: { customData: { fnTest: true } } }), 200);
    // Use CONTACTED to avoid conversion side-effects (client/deal/ticket creation).
    check("PATCH /leads/:id/status CONTACTED -> 200", await req("PATCH", `/leads/${id1}/status`, { token: owner, body: { status: "CONTACTED" } }), 200);
    check("PATCH /leads/:id/verify owner -> 200", await req("PATCH", `/leads/${id1}/verify`, { token: owner, body: { priority: "HOT" } }), 200);
    check("PATCH /leads/:id/self-assign -> 200", await req("PATCH", `/leads/${id1}/self-assign`, { token: owner }), 200);
    check("PATCH /leads/:id/assign -> 200", await req("PATCH", `/leads/${id1}/assign`, { token: owner, body: { assignedToId: USERS.owner.sub } }), 200);
    check("PATCH /leads/:id (update) -> 200", await req("PATCH", `/leads/${id1}`, { token: owner, body: { notes: "FN_TEST update" } }), 200);
    // CheckAbility(update) bulk happy path, scoped to throwaway.
    check("PATCH /leads/bulk owner happy -> 200", await req("PATCH", "/leads/bulk", { token: owner, body: { leadIds: [id1], update: { status: "NEW" } } }), 200);
    // Detail merge: self -> 400; valid loser merge -> 200.
    check("POST /leads/:id/merge self -> 400", await req("POST", `/leads/${id1}/merge`, { token: owner, body: { mergeLeadId: id1 } }), 400);
    if (id2 != null) {
      check("POST /leads/:id/merge loser -> 200", await req("POST", `/leads/${id1}/merge`, { token: owner, body: { mergeLeadId: id2 } }), 200);
    }
  }

  // Import happy path: 1 marked row, no auto-distribute; locate + delete after.
  const importName = `${tag()}_import`;
  const imp = await req("POST", "/leads/import", { token: owner, body: { leads: [{ name: importName }], duplicateAction: "import", autoDistribute: false } });
  check("POST /leads/import owner -> 201", imp, 201);
  const found = await req("GET", `/leads?search=${encodeURIComponent(importName)}`, { token: owner });
  const importedId = found.body?.leads?.find?.((l) => l.name === importName)?.id;

  // ---------------------------------------------------------------------------
  // CLEANUP — delete every throwaway. Exercises DELETE /:id and DELETE /bulk.
  // ---------------------------------------------------------------------------
  if (id1 != null) check("DELETE /leads/:id1 -> 200", await req("DELETE", `/leads/${id1}`, { token: owner }), 200);
  if (id2 != null) check("DELETE /leads/:id2 -> 200", await req("DELETE", `/leads/${id2}`, { token: owner }), 200);
  if (importedId != null) check("DELETE imported lead -> 200", await req("DELETE", `/leads/${importedId}`, { token: owner }), 200);
  if (id3 != null) check("DELETE /leads/bulk owner happy -> 200", await req("DELETE", "/leads/bulk", { token: owner, body: { leadIds: [id3] } }), 200);
  if (id1 != null) check("GET deleted lead -> 404", await req("GET", `/leads/${id1}`, { token: owner }), 404);

  process.exit(report("leads") ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
