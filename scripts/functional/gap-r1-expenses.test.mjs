import { mint, req, check, report } from "./harness.mjs";

const owner = await mint("owner");
const member = await mint("member");
const readOnly = await mint("member", { permissions: ["hr:expenses:read"] });

const VALID_BODY = { filters: {}, sendTo: "BOTH" };

check(
  "no-token POST /hr/expenses/email-report -> 401",
  await req("POST", "/hr/expenses/email-report", { body: VALID_BODY }),
  401,
);

check(
  "member (no perms) POST /hr/expenses/email-report -> 403 (read ability)",
  await req("POST", "/hr/expenses/email-report", { token: member, body: VALID_BODY }),
  403,
);

check(
  "read-only POST /hr/expenses/email-report -> 400 (HR/CEO gate, no send)",
  await req("POST", "/hr/expenses/email-report", { token: readOnly, body: VALID_BODY }),
  400,
);

check(
  "owner POST /hr/expenses/email-report invalid sendTo -> 400 (validation, no send)",
  await req("POST", "/hr/expenses/email-report", {
    token: owner,
    body: { filters: {}, sendTo: "INVALID" },
  }),
  400,
);

check(
  "owner POST /hr/expenses/email-report missing filters -> 400 (validation, no send)",
  await req("POST", "/hr/expenses/email-report", { token: owner, body: {} }),
  400,
);

process.exit(report("gap-r1-expenses") ? 0 : 1);
