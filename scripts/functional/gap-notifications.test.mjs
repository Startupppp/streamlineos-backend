import { mint, req, check, report } from "./harness.mjs";

const member = await mint("member");
const owner = await mint("owner");
const admin = await mint("owner", { role: "ADMIN" });

const validBody = {
  email: "fn-test@example.com",
  subject: "FN_TEST subject",
  body: "FN_TEST body",
  channels: ["email"],
};

check(
  "no-token POST /notifications/dispatch -> 401",
  await req("POST", "/notifications/dispatch", { body: validBody }),
  401,
);

check(
  "member POST /notifications/dispatch -> 403 (role gate)",
  await req("POST", "/notifications/dispatch", { token: member, body: validBody }),
  403,
);

check(
  "owner POST /notifications/dispatch -> 403 (role gate is strict CEO/HR/ADMIN)",
  await req("POST", "/notifications/dispatch", { token: owner, body: validBody }),
  403,
);

check(
  "admin POST /notifications/dispatch missing subject+body -> 400",
  await req("POST", "/notifications/dispatch", { token: admin, body: { channels: ["email"] } }),
  400,
);

check(
  "admin POST /notifications/dispatch empty channels -> 400",
  await req("POST", "/notifications/dispatch", {
    token: admin,
    body: { subject: "x", body: "y", channels: [] },
  }),
  400,
);

check(
  "admin POST /notifications/dispatch invalid email -> 400",
  await req("POST", "/notifications/dispatch", {
    token: admin,
    body: { subject: "x", body: "y", email: "not-an-email", channels: ["email"] },
  }),
  400,
);

check(
  "admin POST /notifications/dispatch email channel without address -> 200 (no send, allFailed)",
  await req("POST", "/notifications/dispatch", {
    token: admin,
    body: { subject: "FN_TEST", body: "FN_TEST", channels: ["email"] },
  }),
  200,
);

process.exit(report("gap-notifications") ? 0 : 1);
