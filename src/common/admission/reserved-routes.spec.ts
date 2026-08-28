import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isReserved } from "./work-class";
import { RESERVED_ROUTES, reservedClassForPath } from "./reserved-routes";

function controllerFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) controllerFiles(full, found);
    else if (entry.endsWith(".controller.ts")) found.push(full);
  }
  return found;
}

function declaredControllerPrefixes(): string[] {
  const prefixes: string[] = [];
  for (const file of controllerFiles(resolve(__dirname, "../..")))
    for (const match of readFileSync(file, "utf8").matchAll(/@Controller\(\s*"([^"]*)"/g))
      prefixes.push(match[1]!.toLowerCase());

  return prefixes;
}

describe("the reserved-route table names routes that exist", () => {
  const prefixes = declaredControllerPrefixes();

  it("finds enough controllers that a broken scan cannot pass vacuously", () => {
    expect(prefixes.length).toBeGreaterThan(200);
  });

  it.each(RESERVED_ROUTES.map((r) => [r.prefix, r.workClass] as const))(
    "%s is served by a real controller",
    (prefix) => {
      const matched = prefixes.some(
        (declared) =>
          declared === prefix ||
          declared.startsWith(`${prefix}/`) ||
          prefix.startsWith(`${declared}/`),
      );

      expect(matched).toBe(true);
    },
  );

  it("only ever maps a route to a reserved class", () => {
    for (const route of RESERVED_ROUTES) expect(isReserved(route.workClass)).toBe(true);
  });

  it("covers every reserved class the PRD names except mandatory security delivery", () => {
    const covered = new Set(RESERVED_ROUTES.map((r) => r.workClass));

    expect([...covered].sort()).toEqual([
      "audit",
      "authentication",
      "authorization-revocation",
      "billing-ledger",
      "ownership",
      "payroll-posting",
    ]);
  });
});

describe("path matching", () => {
  it.each([
    ["/auth/login", "authentication"],
    ["auth/login", "authentication"],
    ["/AUTH/Login", "authentication"],
    ["/sessions", "authorization-revocation"],
    ["/sessions/abc-123", "authorization-revocation"],
    ["/ownership/org/transfer", "ownership"],
    ["/billing/entitlements", "billing-ledger"],
    ["/webhooks/razorpay/org_1", "billing-ledger"],
    ["/payroll/runs/9/approvals", "payroll-posting"],
    ["/internal/audit", "audit"],
    ["/auth/login?next=%2Fhome", "authentication"],
  ])("%s resolves to %s", (path, expected) => {
    expect(reservedClassForPath(path)).toBe(expected);
  });

  it.each([
    "/crm/deals",
    "/build/tickets",
    "/authoring/pages",
    "/payroll/entities",
    "/billingsomethingelse",
    "",
  ])("%s is not reserved, so it stays sheddable", (path) => {
    expect(reservedClassForPath(path)).toBeUndefined();
  });
});
