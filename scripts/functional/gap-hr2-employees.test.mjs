import { mint, req, check, report, USERS } from "./harness.mjs";

const owner = await mint("owner");
const member = await mint("member");

const OWNER_ID = USERS.owner.sub;
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

const validOnboard = {
  firstName: "Test",
  lastName: "Hire",
  email: `fn-onboard-${Date.now()}@example.com`,
  designation: "Engineer",
};

check(
  "no-token GET /hr/employees/:id -> 401",
  await req("GET", `/hr/employees/${OWNER_ID}`),
  401,
);

check(
  "no-token PATCH /hr/employees/:id -> 401",
  await req("PATCH", `/hr/employees/${OWNER_ID}`, { body: { phone: "123" } }),
  401,
);

check(
  "no-token POST /hr/employees/onboard -> 401",
  await req("POST", "/hr/employees/onboard", { body: validOnboard }),
  401,
);

check(
  "owner GET /hr/employees/:id (self) -> 200 (safe read)",
  await req("GET", `/hr/employees/${OWNER_ID}`, { token: owner }),
  200,
);

check(
  "owner GET /hr/employees/:unknown -> 404",
  await req("GET", `/hr/employees/${UNKNOWN_ID}`, { token: owner }),
  404,
);

check(
  "member POST /hr/employees/onboard -> 403 (manage hr:employees gate)",
  await req("POST", "/hr/employees/onboard", { token: member, body: validOnboard }),
  403,
);

check(
  "owner POST /hr/employees/onboard empty body -> 400 (zod)",
  await req("POST", "/hr/employees/onboard", { token: owner, body: {} }),
  400,
);

check(
  "owner POST /hr/employees/onboard future DOB -> 400 (refine)",
  await req("POST", "/hr/employees/onboard", {
    token: owner,
    body: { ...validOnboard, dateOfBirth: "2999-01-01" },
  }),
  400,
);

check(
  "member PATCH /hr/employees/:other -> 403 (not self, not manager)",
  await req("PATCH", `/hr/employees/${OWNER_ID}`, { token: member, body: { phone: "123" } }),
  403,
);

check(
  "owner PATCH /hr/employees/:self terminate self -> 400 (no write)",
  await req("PATCH", `/hr/employees/${OWNER_ID}`, { token: owner, body: { isActive: false } }),
  400,
);

check(
  "owner PATCH /hr/employees/:self report to self -> 400 (no write)",
  await req("PATCH", `/hr/employees/${OWNER_ID}`, { token: owner, body: { reportingTo: OWNER_ID } }),
  400,
);

check(
  "member PATCH /hr/employees/:other toggle dashboard -> 403 (no write)",
  await req("PATCH", `/hr/employees/${UNKNOWN_ID}`, { token: member, body: { hasDashboardAccess: true } }),
  403,
);

process.exit(report("gap-hr2-employees") ? 0 : 1);
