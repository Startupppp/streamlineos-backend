import { mint, req, check, report } from "./harness.mjs";

const FAKE_UUID = "00000000-0000-4000-8000-000000000000";

const run = async () => {
  const owner = await mint("owner");
  const member = await mint("member");

  check("AUTH PATCH /organization/security", await req("PATCH", "/organization/security"), 401);
  check("AUTH POST /organization/members", await req("POST", "/organization/members"), 401);
  check("AUTH PATCH /organization/members/:id", await req("PATCH", "/organization/members/" + FAKE_UUID), 401);

  check(
    "PATCH /organization/security member RBAC-403",
    await req("PATCH", "/organization/security", { token: member, body: { mfaEnforced: true } }),
    403,
  );
  check(
    "PATCH /organization/security owner bad-expiry 400",
    await req("PATCH", "/organization/security", { token: owner, body: { passwordExpiryDays: 10 } }),
    400,
  );
  check(
    "PATCH /organization/security owner empty-body no-op 200",
    await req("PATCH", "/organization/security", { token: owner, body: {} }),
    200,
  );

  check(
    "POST /organization/members member RBAC-403",
    await req("POST", "/organization/members", { token: member, body: { email: "fn-test@example.com", role: "MEMBER" } }),
    403,
  );
  check(
    "POST /organization/members owner missing-email 400",
    await req("POST", "/organization/members", { token: owner, body: { role: "MEMBER" } }),
    400,
  );

  check(
    "PATCH /organization/members/:id member RBAC-403",
    await req("PATCH", "/organization/members/" + FAKE_UUID, { token: member, body: { role: "MEMBER" } }),
    403,
  );
  check(
    "PATCH /organization/members/:id owner empty-body 400",
    await req("PATCH", "/organization/members/" + FAKE_UUID, { token: owner, body: {} }),
    400,
  );
};

run()
  .then(() => process.exit(report("gap-organization") ? 0 : 1))
  .catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
