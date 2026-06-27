import { mint, req, check, report } from "./harness.mjs";

const owner = await mint("owner");
const member = await mint("member");

const validBody = { id: 999999999, status: "APPROVED" };

check(
  "no-token PATCH /hr/work-logs/status -> 401",
  await req("PATCH", "/hr/work-logs/status", { body: validBody }),
  401,
);

check(
  "member PATCH /hr/work-logs/status -> 403 (manage hr:attendance gate)",
  await req("PATCH", "/hr/work-logs/status", { token: member, body: validBody }),
  403,
);

check(
  "owner PATCH /hr/work-logs/status missing id -> 400",
  await req("PATCH", "/hr/work-logs/status", { token: owner, body: { status: "APPROVED" } }),
  400,
);

check(
  "owner PATCH /hr/work-logs/status invalid status -> 400",
  await req("PATCH", "/hr/work-logs/status", { token: owner, body: { id: 1, status: "PENDING" } }),
  400,
);

check(
  "owner PATCH /hr/work-logs/status non-numeric id -> 400",
  await req("PATCH", "/hr/work-logs/status", { token: owner, body: { id: "abc", status: "APPROVED" } }),
  400,
);

check(
  "owner PATCH /hr/work-logs/status unknown id -> 404 (no write)",
  await req("PATCH", "/hr/work-logs/status", { token: owner, body: validBody }),
  404,
);

process.exit(report("gap-hr-work-logs") ? 0 : 1);
