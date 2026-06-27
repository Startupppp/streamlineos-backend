import { mint, req, check, report } from "./harness.mjs";

const owner = await mint("owner");
const member = await mint("member");

const UNKNOWN = 999999999;

check(
  "no-token PUT /hr/leaves/:id/approve -> 401",
  await req("PUT", `/hr/leaves/${UNKNOWN}/approve`, { body: { comment: "ok" } }),
  401,
);

check(
  "no-token PUT /hr/leaves/:id/reject -> 401",
  await req("PUT", `/hr/leaves/${UNKNOWN}/reject`, { body: { reason: "no" } }),
  401,
);

check(
  "member PUT /hr/leaves/:id/approve -> 403 (approve hr:leaves gate)",
  await req("PUT", `/hr/leaves/${UNKNOWN}/approve`, { token: member, body: { comment: "ok" } }),
  403,
);

check(
  "member PUT /hr/leaves/:id/reject -> 403 (approve hr:leaves gate)",
  await req("PUT", `/hr/leaves/${UNKNOWN}/reject`, { token: member, body: { reason: "no" } }),
  403,
);

check(
  "owner PUT /hr/leaves/:id/reject missing reason -> 400",
  await req("PUT", `/hr/leaves/${UNKNOWN}/reject`, { token: owner, body: {} }),
  400,
);

check(
  "owner PUT /hr/leaves/:id/reject empty reason -> 400",
  await req("PUT", `/hr/leaves/${UNKNOWN}/reject`, { token: owner, body: { reason: "" } }),
  400,
);

check(
  "owner PUT /hr/leaves/abc/approve non-numeric id -> 400",
  await req("PUT", "/hr/leaves/abc/approve", { token: owner, body: { comment: "ok" } }),
  400,
);

check(
  "owner PUT /hr/leaves/abc/reject non-numeric id -> 400",
  await req("PUT", "/hr/leaves/abc/reject", { token: owner, body: { reason: "valid reason" } }),
  400,
);

check(
  "owner PUT /hr/leaves/:id/approve unknown id -> 404 (no write)",
  await req("PUT", `/hr/leaves/${UNKNOWN}/approve`, { token: owner, body: { comment: "ok" } }),
  404,
);

check(
  "owner PUT /hr/leaves/:id/reject unknown id -> 404 (no write)",
  await req("PUT", `/hr/leaves/${UNKNOWN}/reject`, { token: owner, body: { reason: "valid reason" } }),
  404,
);

process.exit(report("gap-hr2-leaves") ? 0 : 1);
