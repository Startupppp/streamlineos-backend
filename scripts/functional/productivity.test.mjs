import { USERS, mint, req, check, report } from "./harness.mjs";

const NONE = undefined; // no token
const BAD_UUID = "00000000-0000-0000-0000-000000000000";
const BIG_ID = 999999999;
const FUTURE = "2030-01-01T00:00:00.000Z";

const created = { tasks: [], sequences: [], goals: [], posts: [], categories: [] };

async function main() {
  const owner = await mint("owner");
  const member = await mint("member");
  const sales = await mint("salesRep");

  // ---------------------------------------------------------------------------
  // TASKS  (@UseGuards(JwtAuthGuard) — auth-only, no ability gating)
  // ---------------------------------------------------------------------------
  // AUTH
  check("GET /tasks no-token 401", await req("GET", "/tasks", { token: NONE }), 401);

  // HAPPY (owner)
  check("GET /tasks owner", await req("GET", "/tasks", { token: owner }), 200);
  check("GET /tasks/analytics owner", await req("GET", "/tasks/analytics", { token: owner }), 200);
  check("GET /tasks/my-queue owner", await req("GET", "/tasks/my-queue", { token: owner }), 200);
  check("GET /tasks/overdue owner", await req("GET", "/tasks/overdue", { token: owner }), 200);
  check("GET /tasks/overdue?countOnly owner", await req("GET", "/tasks/overdue?countOnly=true", { token: owner }), 200);
  check("GET /tasks/sequences owner", await req("GET", "/tasks/sequences", { token: owner }), 200);

  // auth-only WRITE not over-gated: member can create+delete a task
  const mTask = await req("POST", "/tasks", { token: member, body: { title: "FN_TEST_member_task" } });
  check("POST /tasks member (auth-only, not over-gated) 201", mTask, 201);
  if (mTask.status === 201 && mTask.body?.id) {
    check("DELETE /tasks/:id member-created cleanup", await req("DELETE", `/tasks/${mTask.body.id}`, { token: owner }), 200);
  }

  // owner full CRUD cycle on a task
  const task = await req("POST", "/tasks", { token: owner, body: { title: "FN_TEST_task", type: "CUSTOM" } });
  check("POST /tasks owner 201", task, 201);
  const taskId = task.body?.id;
  if (taskId) {
    created.tasks.push(taskId);
    check("GET /tasks shows created", await req("GET", `/tasks?limit=100`, { token: owner }), 200);
    check("PATCH /tasks/:id owner", await req("PATCH", `/tasks/${taskId}`, { token: owner, body: { title: "FN_TEST_task_upd" } }), 200);
    check("POST /tasks/:id/complete owner", await req("POST", `/tasks/${taskId}/complete`, { token: owner, body: {} }), [200, 201]);
  }

  // ERROR PATHS
  check("PATCH /tasks/:id non-existent 404", await req("PATCH", `/tasks/${BIG_ID}`, { token: owner, body: { title: "x" } }), 404);
  check("DELETE /tasks/:id non-existent 404", await req("DELETE", `/tasks/${BIG_ID}`, { token: owner }), 404);
  check("POST /tasks/:id/complete non-existent 404", await req("POST", `/tasks/${BIG_ID}/complete`, { token: owner, body: {} }), 404);
  check("PATCH /tasks/:id non-numeric 400", await req("PATCH", `/tasks/abc`, { token: owner, body: { title: "x" } }), 400);
  check("POST /tasks malformed body 400", await req("POST", "/tasks", { token: owner, body: { title: "" } }), 400);

  // sequences cycle (auth-only)
  const seq = await req("POST", "/tasks/sequences", {
    token: owner,
    body: { name: "FN_TEST_seq", steps: [{ title: "FN_TEST_step", offsetDays: 0 }] },
  });
  check("POST /tasks/sequences owner 201", seq, 201);
  const seqId = seq.body?.id ?? seq.body?.sequenceId;
  if (seqId) {
    created.sequences.push(seqId);
    check("DELETE /tasks/sequences/:id owner", await req("DELETE", `/tasks/sequences/${seqId}`, { token: owner }), 200);
    created.sequences.pop();
  }
  check("DELETE /tasks/sequences/:id non-existent 404", await req("DELETE", `/tasks/sequences/${BIG_ID}`, { token: owner }), 404);
  // apply: 404 (non-existent seq, valid body — no persistence) + 400 (malformed)
  check("POST /tasks/sequences/:id/apply non-existent 404", await req("POST", `/tasks/sequences/${BIG_ID}/apply`, { token: owner, body: { baseDate: FUTURE } }), 404);
  check("POST /tasks/sequences/:id/apply malformed 400", await req("POST", `/tasks/sequences/${BIG_ID}/apply`, { token: owner, body: {} }), 400);

  // ---------------------------------------------------------------------------
  // GOALS  (@UseGuards(JwtAuthGuard, AbilityGuard) — @CheckAbility projects:goals)
  // ---------------------------------------------------------------------------
  check("GET /goals no-token 401", await req("GET", "/goals", { token: NONE }), 401);
  check("GET /goals owner", await req("GET", "/goals", { token: owner }), 200);
  check("GET /goals/stats owner", await req("GET", "/goals/stats", { token: owner }), 200);
  // RBAC negative — member lacks projects:goals
  check("GET /goals member 403", await req("GET", "/goals", { token: member }), 403);
  check("POST /goals member 403", await req("POST", "/goals", { token: member, body: { title: "x" } }), 403);

  const goal = await req("POST", "/goals", {
    token: owner,
    body: { title: "FN_TEST_goal", keyResults: [{ title: "FN_TEST_kr0", targetValue: 100 }] },
  });
  check("POST /goals owner 201", goal, 201);
  const goalId = goal.body?.id;
  if (goalId) {
    created.goals.push(goalId);
    check("GET /goals/:id owner", await req("GET", `/goals/${goalId}`, { token: owner }), 200);
    check("PATCH /goals/:id owner", await req("PATCH", `/goals/${goalId}`, { token: owner, body: { status: "on_track" } }), 200);
    check("GET /goals/:id/key-results owner", await req("GET", `/goals/${goalId}/key-results`, { token: owner }), 200);
    check("GET /goals/:id/links owner", await req("GET", `/goals/${goalId}/links`, { token: owner }), 200);

    const krList = await req("GET", `/goals/${goalId}/key-results`, { token: owner });
    const existingKrId = Array.isArray(krList.body) && krList.body[0]?.id;
    if (existingKrId) {
      check("POST /goals/:id/check-in owner", await req("POST", `/goals/${goalId}/check-in`, { token: owner, body: { keyResultId: existingKrId, newValue: 50 } }), [200, 201]);
    }

    const newKr = await req("POST", `/goals/${goalId}/key-results`, { token: owner, body: { title: "FN_TEST_kr1", targetValue: 200 } });
    check("POST /goals/:id/key-results owner 201", newKr, 201);
    const newKrId = newKr.body?.id;
    if (newKrId) {
      check("PATCH /goals/key-results/:id owner", await req("PATCH", `/goals/key-results/${newKrId}`, { token: owner, body: { currentValue: 10 } }), 200);
      check("DELETE /goals/key-results/:id owner", await req("DELETE", `/goals/key-results/${newKrId}`, { token: owner }), 200);
    }

    // links: goal exists, ticket does not -> 404; malformed -> 400; delete non-existent link -> 404
    check("POST /goals/:id/links non-existent ticket 404", await req("POST", `/goals/${goalId}/links`, { token: owner, body: { ticketId: BIG_ID } }), 404);
    check("POST /goals/:id/links malformed 400", await req("POST", `/goals/${goalId}/links`, { token: owner, body: {} }), 400);
    check("DELETE /goals/:id/links non-existent 404", await req("DELETE", `/goals/${goalId}/links?linkId=${BIG_ID}`, { token: owner }), 404);
  }

  // ERROR PATHS
  check("GET /goals/:id non-existent 404", await req("GET", `/goals/${BIG_ID}`, { token: owner }), 404);
  check("GET /goals/:id non-numeric 400", await req("GET", `/goals/abc`, { token: owner }), 400);
  check("PATCH /goals/key-results/:id non-existent 404", await req("PATCH", `/goals/key-results/${BIG_ID}`, { token: owner, body: { currentValue: 1 } }), 404);
  check("DELETE /goals/key-results/:id non-existent 404", await req("DELETE", `/goals/key-results/${BIG_ID}`, { token: owner }), 404);
  check("POST /goals malformed body 400", await req("POST", "/goals", { token: owner, body: {} }), 400);

  // cleanup created goal (cascades key results)
  if (goalId) {
    check("DELETE /goals/:id owner cleanup", await req("DELETE", `/goals/${goalId}`, { token: owner }), 200);
    created.goals.pop();
  }

  // ---------------------------------------------------------------------------
  // BLOG  (@UseGuards(JwtAuthGuard, AbilityGuard); some @Public)
  // ---------------------------------------------------------------------------
  check("GET /blog/categories public no-token 200", await req("GET", "/blog/categories", { token: NONE }), 200);
  check("GET /blog/feed public no-token 200", await req("GET", "/blog/feed", { token: NONE }), 200);
  check("GET /blog/posts no-token 401", await req("GET", "/blog/posts", { token: NONE }), 401);
  check("GET /blog/posts owner", await req("GET", "/blog/posts", { token: owner }), 200);
  // RBAC negative — member lacks blog:posts / blog:categories
  check("GET /blog/posts member 403", await req("GET", "/blog/posts", { token: member }), 403);
  check("POST /blog/categories member 403", await req("POST", "/blog/categories", { token: member, body: { name: "x" } }), 403);

  // categories cycle (create -> verify in public list -> patch -> delete)
  const cat = await req("POST", "/blog/categories", { token: owner, body: { name: "FN_TEST_cat", color: "#3B82F6" } });
  check("POST /blog/categories owner 201", cat, 201);
  const catId = cat.body?.id;
  if (catId) {
    created.categories.push(catId);
    const cats = await req("GET", "/blog/categories", { token: owner });
    const found = Array.isArray(cats.body) && cats.body.some((c) => c.id === catId);
    check("GET /blog/categories contains created", { status: found ? 200 : 500 }, 200);
    check("PATCH /blog/categories/:id owner", await req("PATCH", `/blog/categories/${catId}`, { token: owner, body: { description: "fn test" } }), 200);
    check("DELETE /blog/categories/:id owner cleanup", await req("DELETE", `/blog/categories/${catId}`, { token: owner }), 200);
    created.categories.pop();
  }
  check("POST /blog/categories malformed 400", await req("POST", "/blog/categories", { token: owner, body: { name: "x", color: "notahex" } }), 400);
  check("PATCH /blog/categories/:id non-existent 404", await req("PATCH", `/blog/categories/${BAD_UUID}`, { token: owner, body: { name: "x" } }), 404);
  check("DELETE /blog/categories/:id non-existent 404", await req("DELETE", `/blog/categories/${BAD_UUID}`, { token: owner }), 404);

  // posts cycle (create -> get -> patch -> delete)
  const post = await req("POST", "/blog/posts", {
    token: owner,
    body: { title: "FN_TEST_post", excerpt: "fn excerpt", content: "fn content body", coverImage: "https://example.com/x.png", status: "draft" },
  });
  check("POST /blog/posts owner 201", post, 201);
  const postId = post.body?.id;
  if (postId) {
    created.posts.push(postId);
    check("GET /blog/posts/:id owner", await req("GET", `/blog/posts/${postId}`, { token: owner }), 200);
    check("PATCH /blog/posts/:id owner", await req("PATCH", `/blog/posts/${postId}`, { token: owner, body: { excerpt: "fn excerpt 2" } }), 200);
    check("DELETE /blog/posts/:id owner cleanup", await req("DELETE", `/blog/posts/${postId}`, { token: owner }), 200);
    created.posts.pop();
  }
  check("GET /blog/posts/:id non-existent 404", await req("GET", `/blog/posts/${BAD_UUID}`, { token: owner }), 404);
  check("PATCH /blog/posts/:id non-existent 404", await req("PATCH", `/blog/posts/${BAD_UUID}`, { token: owner, body: { excerpt: "x" } }), 404);
  check("DELETE /blog/posts/:id non-existent 404", await req("DELETE", `/blog/posts/${BAD_UUID}`, { token: owner }), 404);
  check("POST /blog/posts malformed 400", await req("POST", "/blog/posts", { token: owner, body: { title: "x" } }), 400);

  // ---------------------------------------------------------------------------
  // EXPENSES  (/hr/expenses — auth-only; categories POST @CheckAbility; import handler-gated)
  // ---------------------------------------------------------------------------
  check("GET /hr/expenses no-token 401", await req("GET", "/hr/expenses", { token: NONE }), 401);
  check("GET /hr/expenses owner", await req("GET", "/hr/expenses", { token: owner }), 200);
  check("GET /hr/expenses member (auth-only, not over-gated)", await req("GET", "/hr/expenses", { token: member }), 200);
  check("GET /hr/expenses/page-data owner", await req("GET", "/hr/expenses/page-data", { token: owner }), 200);
  check("GET /hr/expenses/report owner", await req("GET", "/hr/expenses/report?startDate=2020-01-01&endDate=2030-12-31", { token: owner }), 200);
  check("GET /hr/expenses/report missing dates 400", await req("GET", "/hr/expenses/report", { token: owner }), 400);
  check("GET /hr/expenses/export owner (csv)", await req("GET", "/hr/expenses/export", { token: owner }), 200);
  check("GET /hr/expenses/categories owner", await req("GET", "/hr/expenses/categories", { token: owner }), 200);
  // categories POST — RBAC negative + malformed (skip happy create: no delete route)
  check("POST /hr/expenses/categories member 403", await req("POST", "/hr/expenses/categories", { token: member, body: { name: "x" } }), 403);
  check("POST /hr/expenses/categories malformed (owner) 400", await req("POST", "/hr/expenses/categories", { token: owner, body: {} }), 400);
  // DELETE expense — error paths only (no destructive real delete)
  check("DELETE /hr/expenses/:id non-existent 404", await req("DELETE", `/hr/expenses/${BIG_ID}`, { token: owner }), 404);
  check("DELETE /hr/expenses/:id non-numeric 400", await req("DELETE", `/hr/expenses/abc`, { token: owner }), 400);
  // import — auth required; handler-gated to approvers; skip real import
  check("POST /hr/expenses/import no-token 401", await req("POST", "/hr/expenses/import", { token: NONE, body: { fileName: "x.csv", content: "" } }), 401);
  check("POST /hr/expenses/import member 403 (handler gate)", await req("POST", "/hr/expenses/import", { token: member, body: { fileName: "FN_TEST.csv", content: "" } }), 403);
  check("POST /hr/expenses/import malformed (owner) 400", await req("POST", "/hr/expenses/import", { token: owner, body: {} }), 400);

  // ---------------------------------------------------------------------------
  // CAREERS  (public)
  // ---------------------------------------------------------------------------
  check("GET /careers public no-token 200", await req("GET", "/careers", { token: NONE }), 200);
  check("POST /careers/apply non-existent job 404", await req("POST", "/careers/apply", { token: NONE, body: { jobPostingId: BIG_ID, name: "FN_TEST Applicant", email: "fn-test@example.com" } }), 404);
  check("POST /careers/apply malformed 400", await req("POST", "/careers/apply", { token: NONE, body: {} }), 400);

  // ---------------------------------------------------------------------------
  // ONBOARDING  (auth-only class guard; some methods @CheckAbility settings:onboarding)
  // ---------------------------------------------------------------------------
  check("GET /onboarding no-token 401", await req("GET", "/onboarding", { token: NONE }), 401);
  check("GET /onboarding owner", await req("GET", "/onboarding", { token: owner }), 200);
  check("GET /onboarding member 403", await req("GET", "/onboarding", { token: member }), 403);
  check("GET /onboarding/templates owner", await req("GET", "/onboarding/templates", { token: owner }), 200);
  check("GET /onboarding/templates member 403", await req("GET", "/onboarding/templates", { token: member }), 403);
  // initiate — non-existent user -> 404 (no persist); member -> 403; malformed -> 400
  check("POST /onboarding non-existent user 404", await req("POST", "/onboarding", { token: owner, body: { userId: BAD_UUID } }), 404);
  check("POST /onboarding member 403", await req("POST", "/onboarding", { token: member, body: { userId: BAD_UUID } }), 403);
  check("POST /onboarding malformed 400", await req("POST", "/onboarding", { token: owner, body: {} }), 400);
  // create template — RBAC negative + malformed (skip real create: no delete route)
  check("POST /onboarding/templates member 403", await req("POST", "/onboarding/templates", { token: member, body: { name: "x" } }), 403);
  check("POST /onboarding/templates malformed (owner) 400", await req("POST", "/onboarding/templates", { token: owner, body: {} }), 400);
  // personal/bank details — auth-only; verify reachable+not over-gated via 401 + validation (skip real mutation)
  check("PATCH /onboarding/personal-details no-token 401", await req("PATCH", "/onboarding/personal-details", { token: NONE, body: { phone: "1" } }), 401);
  check("PATCH /onboarding/personal-details member malformed 400 (not over-gated)", await req("PATCH", "/onboarding/personal-details", { token: member, body: {} }), 400);
  check("PATCH /onboarding/bank-details no-token 401", await req("PATCH", "/onboarding/bank-details", { token: NONE, body: {} }), 401);
  check("PATCH /onboarding/bank-details member malformed 400 (not over-gated)", await req("PATCH", "/onboarding/bank-details", { token: member, body: {} }), 400);
  // submit — auth-only; verify guard only (skip real mutation: no undo, no body to invalidate)
  check("POST /onboarding/submit no-token 401", await req("POST", "/onboarding/submit", { token: NONE }), 401);
  // GET /onboarding/:userId — service-level forbidden check
  check("GET /onboarding/:userId owner viewing member 200", await req("GET", `/onboarding/${USERS.member.sub}`, { token: owner }), 200);
  check("GET /onboarding/:userId member viewing self 200", await req("GET", `/onboarding/${USERS.member.sub}`, { token: member }), 200);
  check("GET /onboarding/:userId member viewing other 403", await req("GET", `/onboarding/${USERS.owner.sub}`, { token: member }), 403);
  check("GET /onboarding/:userId no-token 401", await req("GET", `/onboarding/${USERS.member.sub}`, { token: NONE }), 401);

  // ---------------------------------------------------------------------------
  // AUDIT-LOG  (@CheckAbility read audit-log)
  // ---------------------------------------------------------------------------
  check("GET /audit-log no-token 401", await req("GET", "/audit-log", { token: NONE }), 401);
  check("GET /audit-log owner", await req("GET", "/audit-log", { token: owner }), 200);
  check("GET /audit-log/actions owner", await req("GET", "/audit-log/actions", { token: owner }), 200);
  check("GET /audit-log/target-types owner", await req("GET", "/audit-log/target-types", { token: owner }), 200);
  check("GET /audit-log member 403", await req("GET", "/audit-log", { token: member }), 403);
  check("GET /audit-log/actions salesRep 403", await req("GET", "/audit-log/actions", { token: sales }), 403);

  // ---------------------------------------------------------------------------
  // PLATFORM  (public visit)
  // ---------------------------------------------------------------------------
  check("GET /platform/visit usage 405", await req("GET", "/platform/visit", { token: NONE }), 405);
  check("POST /platform/visit malformed 400", await req("POST", "/platform/visit", { token: NONE, body: {} }), 400);
  check("POST /platform/visit valid 200 (append-only analytics)", await req("POST", "/platform/visit", { token: NONE, body: { sessionToken: "FN_TEST_visit", path: "/fn-test" } }), 200);
}

main()
  .catch((e) => { console.error("FATAL", e); process.exitCode = 1; })
  .finally(() => {
    process.exit(report("productivity") ? 0 : 1);
  });
