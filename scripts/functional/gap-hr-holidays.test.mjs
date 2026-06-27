import { mint, req, check, report } from "./harness.mjs";

async function main() {
  const member = await mint("member");
  const year = new Date().getFullYear();

  check("AUTH no-token GET /hr/holidays -> 401", await req("GET", "/hr/holidays"), 401);

  check(
    "HAPPY GET /hr/holidays member -> 200",
    await req("GET", "/hr/holidays", { token: member }),
    200,
  );

  check(
    "HAPPY GET /hr/holidays?year -> 200",
    await req("GET", `/hr/holidays?year=${year}`, { token: member }),
    200,
  );

  check(
    "HAPPY GET /hr/holidays?year=abc (coerced) -> 200",
    await req("GET", "/hr/holidays?year=abc", { token: member }),
    200,
  );

  const list = await req("GET", `/hr/holidays?year=${year}`, { token: member });
  check("SHAPE GET /hr/holidays returns array -> 200", list, 200);
  if (list.status === 200 && !Array.isArray(list.body)) {
    console.log("  FAIL: GET /hr/holidays did not return an array");
    process.exit(1);
  }

  process.exit(report("gap-hr-holidays") ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
