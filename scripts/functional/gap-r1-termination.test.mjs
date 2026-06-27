import { mint, req, check, report } from "./harness.mjs";

const owner = await mint("owner");
const member = await mint("member");
const hr = await mint("hrManager", { role: "HR", isOrgOwner: true });

const UNKNOWN_ID = 999999999;

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
  "hr POST /hr/termination/:unknown/send-email -> 404 (no send)",
  await req("POST", `/hr/termination/${UNKNOWN_ID}/send-email`, { token: hr, body: {} }),
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
  "hr PATCH /hr/termination/:unknown/complete -> 404 (no write, no cache invalidation)",
  await req("PATCH", `/hr/termination/${UNKNOWN_ID}/complete`, { token: hr, body: {} }),
  404,
);

process.exit(report("gap-r1-termination") ? 0 : 1);
