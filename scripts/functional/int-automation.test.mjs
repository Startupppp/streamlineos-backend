import { ORG, USERS, mint, req, check, report } from "./harness.mjs";

// ---------------------------------------------------------------------------
// Functional test: automation integration module (src/modules/automation).
//
// The automation module exposes exactly ONE route:
//   POST /settings/automations/:ruleId/test   (JwtAuthGuard + AbilityGuard)
//     guard: CheckAbility("manage", "settings:automations")
//     param: ruleId -> ParseIntPipe  (non-int -> 400)
//     body : { payload?: Record<string, unknown> }  (zod, default {})
//
// The rule CRUD used to find / create / delete benign fixtures lives in the
// settings module (GET/POST/DELETE /settings/automations).
//
// SAFETY (critical): testRule() is NOT a dry run. It calls runRule ->
// executeAction, which REALLY fires email (Resend, live key in .env), webhooks,
// in-app notifications and task inserts. To exercise the live handler without
// spamming anyone we only ever test benign rules we create ourselves:
//   - a rule whose condition never matches the test payload  -> matched=false,
//     zero actions execute (status "skipped");
//   - a rule that matches but whose only action is notify_roles to a role that
//     no org member holds -> notifyMembers resolves 0 targets and returns early,
//     so NO notification is delivered (status "success", action ok=true).
// We never trigger an `email`, `webhook` or `notify_all` action. No external
// integration call (email/webhook/push) is fired by this suite.
// ---------------------------------------------------------------------------

const FAKE_ID = 999999999; // valid int4, no such rule -> 404 after guards pass
const NONEXISTENT_ROLE = "__FN_NONEXISTENT_ROLE__";
const created = [];

// shape assertion that participates in the harness pass/fail counters
const expectTrue = (name, cond) => check(name, { status: cond ? 1 : 0 }, 1);

const run = async () => {
  const owner = await mint("owner"); // isOrgOwner -> manage:all
  const member = await mint("member"); // no perms
  const salesRep = await mint("salesRep"); // role only, no perms
  const hrManager = await mint("hrManager"); // role only, no perms
  // view-only: has settings:automations:view but NOT manage -> must be denied
  const viewer = await mint("member", { permissions: ["settings:automations:view"] });
  // wrong module/resource manage perm -> must be denied
  const wrongPerm = await mint("member", { permissions: ["crm:leads:manage"] });
  // correct manage perm, default (enterprise) plan
  const manager = await mint("member", { permissions: ["settings:automations:manage"] });
  // correct manage perm but on the FREE plan -> route is NOT plan-gated, must pass RBAC
  const freeManager = await mint("member", {
    permissions: ["settings:automations:manage"],
    plan: "free",
  });

  // ----------------------------------------------------------------- AUTH 401
  check("AUTH POST /settings/automations/1/test (no token)", await req("POST", "/settings/automations/1/test"), 401);
  check(
    "AUTH POST /settings/automations/1/test (garbage token)",
    await req("POST", "/settings/automations/1/test", { token: "not-a-jwt", body: {} }),
    401,
  );

  // ------------------------------------------------------------- RBAC NEGATIVE
  // Guards run before the ParseInt/Zod pipes and before the 404 lookup, so a
  // denied caller gets 403 even against a non-existent rule id + bad body.
  const rbacDenied = [
    ["member (no perms)", member],
    ["salesRep (role only)", salesRep],
    ["hrManager (role only)", hrManager],
    ["viewer (settings:automations:view, lacks manage)", viewer],
    ["wrongPerm (crm:leads:manage)", wrongPerm],
  ];
  for (const [label, token] of rbacDenied) {
    check(
      `RBAC ${label} -> 403`,
      await req("POST", `/settings/automations/${FAKE_ID}/test`, { token, body: { payload: {} } }),
      403,
    );
  }

  // -------------------------------------------------- PLAN: route not gated
  // manage perm holders pass RBAC regardless of plan (no 402 path on this route).
  // They fall through to the 404 not-found lookup, proving the guard let them in.
  check(
    "PLAN free-plan manager passes RBAC (no 402) -> 404 on missing rule",
    await req("POST", `/settings/automations/${FAKE_ID}/test`, { token: freeManager, body: { payload: {} } }),
    404,
  );
  check(
    "PLAN enterprise manager passes RBAC -> 404 on missing rule",
    await req("POST", `/settings/automations/${FAKE_ID}/test`, { token: manager, body: { payload: {} } }),
    404,
  );

  // ---------------------------------------------------------- INPUT VALIDATION
  // ruleId param: ParseIntPipe rejects non-integers with 400 (guards already passed).
  check(
    "VALIDATION ruleId 'abc' -> 400",
    await req("POST", "/settings/automations/abc/test", { token: owner, body: { payload: {} } }),
    400,
  );
  check(
    "VALIDATION ruleId '1.5' -> 400",
    await req("POST", "/settings/automations/1.5/test", { token: owner, body: { payload: {} } }),
    400,
  );
  // body: payload must be an object record; scalars -> zod 400.
  check(
    "VALIDATION body payload=string -> 400",
    await req("POST", `/settings/automations/${FAKE_ID}/test`, { token: owner, body: { payload: "nope" } }),
    400,
  );
  check(
    "VALIDATION body payload=number -> 400",
    await req("POST", `/settings/automations/${FAKE_ID}/test`, { token: owner, body: { payload: 123 } }),
    400,
  );
  check(
    "VALIDATION body payload=null -> 400",
    await req("POST", `/settings/automations/${FAKE_ID}/test`, { token: owner, body: { payload: null } }),
    400,
  );
  // valid bodies (omitted / empty object) must pass validation and reach the
  // 404 lookup, NOT be rejected as 400.
  check(
    "VALIDATION omitted body (payload defaults {}) -> 404 not 400",
    await req("POST", `/settings/automations/${FAKE_ID}/test`, { token: owner }),
    404,
  );
  check(
    "VALIDATION empty payload {} -> 404 not 400",
    await req("POST", `/settings/automations/${FAKE_ID}/test`, { token: owner, body: { payload: {} } }),
    404,
  );

  // ---------------------------------------------------- GRACEFUL NOT-FOUND 404
  const nf = await req("POST", `/settings/automations/${FAKE_ID}/test`, {
    token: owner,
    body: { payload: { any: "thing" } },
  });
  check("NOTFOUND owner test missing rule -> 404", nf, 404);
  expectTrue(
    "NOTFOUND body error == 'Automation not found'",
    nf.body && nf.body.error === "Automation not found",
  );

  // ------------------------------------------------------------ SAFE REAL CALL
  // Discover existing rules first (the task's "GET the rules" step).
  const list = await req("GET", "/settings/automations", { token: owner });
  check("SETUP GET /settings/automations -> 200", list, 200);
  expectTrue("SETUP rules list is an array", Array.isArray(list.body));

  // Benign rule A: a condition that never matches the {} test payload.
  const ruleA = await req("POST", "/settings/automations", {
    token: owner,
    body: {
      name: "FN_TEST_automation_safe_nomatch",
      description: "fn-test benign; condition never matches; disabled",
      triggerEvent: "lead.created",
      conditions: [{ field: "__fn_never_present__", op: "eq", value: "__nope__" }],
      actions: [{ type: "notify_roles", config: { roles: [NONEXISTENT_ROLE], title: "fn-test", message: "fn-test" } }],
      isEnabled: false,
    },
  });
  check("SETUP create benign rule A -> 201", ruleA, 201);
  const idA = ruleA.body?.id;
  if (typeof idA === "number") created.push(idA);

  // Benign rule B: empty conditions (always matches) + notify_roles to a role
  // no member holds -> the action executes but delivers 0 notifications.
  const ruleB = await req("POST", "/settings/automations", {
    token: owner,
    body: {
      name: "FN_TEST_automation_safe_match",
      description: "fn-test benign; matches but notifies a nonexistent role; disabled",
      triggerEvent: "lead.created",
      conditions: [],
      actions: [{ type: "notify_roles", config: { roles: [NONEXISTENT_ROLE], title: "fn-test", message: "fn-test" } }],
      isEnabled: false,
    },
  });
  check("SETUP create benign rule B -> 201", ruleB, 201);
  const idB = ruleB.body?.id;
  if (typeof idB === "number") created.push(idB);

  // ---- REAL CALL 1: non-matching rule -> skipped, zero actions executed.
  if (typeof idA === "number") {
    const t1 = await req("POST", `/settings/automations/${idA}/test`, {
      token: owner,
      body: { payload: {} },
    });
    check("REAL test rule A (no match) -> 200", t1, 200);
    const b1 = t1.body ?? {};
    expectTrue("REAL A runId is a number", typeof b1.runId === "number");
    expectTrue("REAL A matched === false", b1.matched === false);
    expectTrue("REAL A status === 'skipped'", b1.status === "skipped");
    expectTrue(
      "REAL A actionResults is empty array (no actions fired)",
      Array.isArray(b1.actionResults) && b1.actionResults.length === 0,
    );

    // RBAC on a REAL rule id (not just FAKE): member must still be denied.
    check(
      "REAL test rule A as member -> 403",
      await req("POST", `/settings/automations/${idA}/test`, { token: member, body: { payload: {} } }),
      403,
    );
  } else {
    expectTrue("REAL A rule was created (id captured)", false);
  }

  // ---- REAL CALL 2: matching rule, benign action -> success, 0 deliveries.
  if (typeof idB === "number") {
    const t2 = await req("POST", `/settings/automations/${idB}/test`, {
      token: owner,
      body: { payload: { stage: "new", anything: 1 } },
    });
    check("REAL test rule B (match, benign action) -> 200", t2, 200);
    const b2 = t2.body ?? {};
    expectTrue("REAL B runId is a number", typeof b2.runId === "number");
    expectTrue("REAL B matched === true", b2.matched === true);
    expectTrue("REAL B status === 'success'", b2.status === "success");
    expectTrue(
      "REAL B actionResults has one notify_roles ok=true",
      Array.isArray(b2.actionResults) &&
        b2.actionResults.length === 1 &&
        b2.actionResults[0]?.type === "notify_roles" &&
        b2.actionResults[0]?.ok === true,
    );
  } else {
    expectTrue("REAL B rule was created (id captured)", false);
  }

  // --------------------------------------------------------------- CLEANUP
  for (const id of created) {
    const del = await req("DELETE", `/settings/automations/${id}`, { token: owner });
    check(`CLEANUP delete rule ${id} -> 200`, del, 200);
  }

  return report("int-automation");
};

run()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
