import { mint, req, check, report } from "./harness.mjs";

const run = async () => {
  const owner = await mint("owner");
  const member = await mint("member");

  const validBody = {
    companyName: "FN_TEST_co",
    industry: "Technology",
    companySize: "11-50",
    country: "India",
    firstName: "FN",
    lastName: "Test",
    jobTitle: "Founder",
    phone: "+10000000000",
  };

  check("AUTH PATCH /org/setup no-token 401", await req("PATCH", "/org/setup", { body: validBody }), 401);

  check("PATCH /org/setup member non-owner 403", await req("PATCH", "/org/setup", { token: member, body: validBody }), 403);

  check("PATCH /org/setup owner empty-body 400", await req("PATCH", "/org/setup", { token: owner, body: {} }), 400);
  check("PATCH /org/setup owner missing-fields 400", await req("PATCH", "/org/setup", { token: owner, body: { companyName: "x" } }), 400);
};

run()
  .then(() => process.exit(report("gap-org") ? 0 : 1))
  .catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
