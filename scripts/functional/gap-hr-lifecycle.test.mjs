import { mint, req, check, report } from "./harness.mjs";

const owner = await mint("owner");
const member = await mint("member");
const hrApprover = await mint("hrManager", { role: "HR", isOrgOwner: true });

const UNKNOWN_ID = 999999999;

check(
  "no-token GET /hr/exit -> 401",
  await req("GET", "/hr/exit"),
  401,
);

check(
  "member GET /hr/exit -> 200 (own resignations)",
  await req("GET", "/hr/exit", { token: member }),
  200,
);

check(
  "no-token GET /hr/exit/:id -> 401",
  await req("GET", `/hr/exit/${UNKNOWN_ID}`),
  401,
);

check(
  "member GET /hr/exit/abc -> 400 (non-numeric id)",
  await req("GET", "/hr/exit/abc", { token: member }),
  400,
);

check(
  "member GET /hr/exit/:unknown -> 404",
  await req("GET", `/hr/exit/${UNKNOWN_ID}`, { token: member }),
  404,
);

check(
  "no-token PATCH /hr/exit/:id/hr-review -> 401",
  await req("PATCH", `/hr/exit/${UNKNOWN_ID}/hr-review`, { body: { decision: "approve" } }),
  401,
);

check(
  "member PATCH /hr/exit/:id/hr-review -> 403 (manage hr:exit gate)",
  await req("PATCH", `/hr/exit/${UNKNOWN_ID}/hr-review`, { token: member, body: { decision: "approve" } }),
  403,
);

check(
  "owner(non HR/CEO role) PATCH /hr/exit/:id/hr-review -> 403 (role gate)",
  await req("PATCH", `/hr/exit/${UNKNOWN_ID}/hr-review`, { token: owner, body: { decision: "approve" } }),
  403,
);

check(
  "hr PATCH /hr/exit/:id/hr-review invalid decision -> 400",
  await req("PATCH", `/hr/exit/${UNKNOWN_ID}/hr-review`, { token: hrApprover, body: { decision: "maybe" } }),
  400,
);

check(
  "hr PATCH /hr/exit/abc/hr-review -> 400 (non-numeric id)",
  await req("PATCH", "/hr/exit/abc/hr-review", { token: hrApprover, body: { decision: "approve" } }),
  400,
);

check(
  "hr PATCH /hr/exit/:id/hr-review reject without remarks -> 400",
  await req("PATCH", `/hr/exit/${UNKNOWN_ID}/hr-review`, { token: hrApprover, body: { decision: "reject" } }),
  400,
);

check(
  "hr PATCH /hr/exit/:unknown/hr-review approve -> 404 (no write)",
  await req("PATCH", `/hr/exit/${UNKNOWN_ID}/hr-review`, { token: hrApprover, body: { decision: "approve" } }),
  404,
);

check(
  "no-token POST /hr/termination/:id/send-email -> 401",
  await req("POST", `/hr/termination/${UNKNOWN_ID}/send-email`, { body: {} }),
  401,
);

check(
  "member POST /hr/termination/:id/send-email -> 403 (HR/CEO gate)",
  await req("POST", `/hr/termination/${UNKNOWN_ID}/send-email`, { token: member, body: {} }),
  403,
);

check(
  "owner POST /hr/termination/abc/send-email -> 400 (non-numeric id)",
  await req("POST", "/hr/termination/abc/send-email", { token: owner, body: {} }),
  400,
);

check(
  "owner POST /hr/termination/:unknown/send-email -> 404 (no email)",
  await req("POST", `/hr/termination/${UNKNOWN_ID}/send-email`, { token: owner, body: {} }),
  404,
);

check(
  "no-token PATCH /hr/termination/:id/complete -> 401",
  await req("PATCH", `/hr/termination/${UNKNOWN_ID}/complete`, { body: {} }),
  401,
);

check(
  "member PATCH /hr/termination/:id/complete -> 403 (HR/CEO gate)",
  await req("PATCH", `/hr/termination/${UNKNOWN_ID}/complete`, { token: member, body: {} }),
  403,
);

check(
  "owner PATCH /hr/termination/abc/complete -> 400 (non-numeric id)",
  await req("PATCH", "/hr/termination/abc/complete", { token: owner, body: {} }),
  400,
);

check(
  "owner PATCH /hr/termination/:unknown/complete -> 404 (no write)",
  await req("PATCH", `/hr/termination/${UNKNOWN_ID}/complete`, { token: owner, body: {} }),
  404,
);

process.exit(report("gap-hr-lifecycle") ? 0 : 1);
