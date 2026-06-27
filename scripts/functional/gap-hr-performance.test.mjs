import { mint, req, check, report, USERS } from "./harness.mjs";

// gap-hr-performance: two missing LIST GETs on PerformanceController (@Controller "hr/performance")
//   GET /hr/performance/cycles   — list review cycles for the org (auth-only).
//   GET /hr/performance/reviews  — list reviews with frontend query filters
//                                  (userId / cycleId / limit / offset); non-admin is
//                                  scoped to own reviews, and requesting ANOTHER user's
//                                  reviews without manage hr:performance -> 403.
// Safe-read only: no writes, no emails. Mirrors app/api/hr/performance/{cycles,reviews}/route.ts GET.

const owner = await mint("owner", { enabledModules: ["hr"] });
const member = await mint("member", { enabledModules: ["hr"] });

async function main() {
  // AUTH: no token -> 401
  check("AUTH GET /hr/performance/cycles -> 401", await req("GET", "/hr/performance/cycles"), 401);
  check("AUTH GET /hr/performance/reviews -> 401", await req("GET", "/hr/performance/reviews"), 401);

  // cycles list: auth-only, owner + member both 200
  check("GET /hr/performance/cycles owner -> 200", await req("GET", "/hr/performance/cycles", { token: owner }), 200);
  check("GET /hr/performance/cycles member (not over-gated) -> 200", await req("GET", "/hr/performance/cycles", { token: member }), 200);

  // reviews list: admin (owner) sees org-wide -> 200
  check("GET /hr/performance/reviews owner -> 200", await req("GET", "/hr/performance/reviews", { token: owner }), 200);
  // member sees own reviews -> 200 (not over-gated)
  check("GET /hr/performance/reviews member (own) -> 200", await req("GET", "/hr/performance/reviews", { token: member }), 200);

  // member requesting their OWN userId explicitly -> 200
  check(
    "GET /hr/performance/reviews member self userId -> 200",
    await req("GET", `/hr/performance/reviews?userId=${USERS.member.sub}`, { token: member }),
    200,
  );
  // member requesting ANOTHER user's reviews without manage hr:performance -> 403
  check(
    "GET /hr/performance/reviews other-user member -> 403",
    await req("GET", `/hr/performance/reviews?userId=${USERS.owner.sub}`, { token: member }),
    403,
  );

  // owner with filters (cycleId / limit / offset) -> 200
  check(
    "GET /hr/performance/reviews owner filtered -> 200",
    await req("GET", "/hr/performance/reviews?cycleId=999999&limit=10&offset=0", { token: owner }),
    200,
  );
  // owner may request any user's reviews -> 200
  check(
    "GET /hr/performance/reviews owner other-user -> 200",
    await req("GET", `/hr/performance/reviews?userId=${USERS.member.sub}`, { token: owner }),
    200,
  );
}

main().then(() => process.exit(report("gap-hr-performance") ? 0 : 1)).catch((e) => {
  console.error(e);
  process.exit(1);
});
