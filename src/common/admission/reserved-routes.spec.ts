import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isReserved } from "./work-class";
import { RESERVED_ROUTES, normalisePath, reservedClassForPath } from "./reserved-routes";

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

  it.each([
    "/auth/../crm/deals",
    "/auth/../../crm/deals",
    "/billing/../crm/deals",
    "/payroll/runs/../entities",
    "/./auth/../crm/deals",
  ])("%s cannot borrow reserved capacity by traversing out of a reserved prefix", (path) => {
    expect(reservedClassForPath(path)).toBeUndefined();
  });

  it.each(["//auth/login", "/auth//login", "/auth/./login", "/auth/login/"])(
    "%s still resolves to the reserved class it genuinely reaches",
    (path) => {
      expect(reservedClassForPath(path)).toBe("authentication");
    },
  );

  it.each(["/auth%2f../crm/deals", "/auth%2e%2e/crm", "/auth./login", "/authsomething"])(
    "%s is left alone rather than decoded into a reserved match",
    (path) => {
      expect(reservedClassForPath(path)).toBeUndefined();
    },
  );

  it("clamps traversal at the root rather than emitting a path above it", () => {
    expect(normalisePath("/../../etc/passwd")).toBe("etc/passwd");
    expect(normalisePath("/auth/../../..")).toBe("");
  });

  it("classifies a traversal by where it actually lands, not by its prefix", () => {
    expect(reservedClassForPath("/../auth/login")).toBe("authentication");
    expect(reservedClassForPath("/auth/../crm/deals")).toBeUndefined();
  });
});

describe("the URI version prefix does not defeat reserved classification", () => {
  it.each([
    ["/v1/auth/login", "authentication"],
    ["/v2/auth/login", "authentication"],
    ["/v1/sessions/abc-123", "authorization-revocation"],
    ["/v1/billing/entitlements", "billing-ledger"],
    ["/v1/payroll/runs/9/approvals", "payroll-posting"],
    ["/V1/Auth/Login", "authentication"],
    ["/v1/internal/audit", "audit"],
  ])("%s resolves to %s, exactly as the unversioned spelling does", (path, expected) => {
    expect(reservedClassForPath(path)).toBe(expected);
  });

  it("strips only versions the API declares, never a controller that starts with v", () => {
    expect(normalisePath("/v9/auth/login")).toBe("v9/auth/login");
    expect(normalisePath("/vendors/auth")).toBe("vendors/auth");
    expect(normalisePath("/v1")).toBe("");
  });

  it("leaves a version segment that is not the first one alone", () => {
    expect(normalisePath("/agent/v1/me")).toBe("agent/v1/me");
    expect(normalisePath("/portal/v1/projects")).toBe("portal/v1/projects");
  });

  it("resolves traversal before reading the version segment", () => {
    expect(reservedClassForPath("/v1/auth/../crm/deals")).toBeUndefined();
    expect(reservedClassForPath("/v1/../auth/login")).toBe("authentication");
  });
});

describe("the access snapshot", () => {
  it.each(["/me/access", "/v1/me/access", "/me/access?refresh=1"])(
    "%s is reserved, so the read every page gates on is never shed",
    (path) => {
      expect(reservedClassForPath(path)).toBe("authorization-revocation");
    },
  );

  it("does not reserve the rest of /me", () => {
    expect(reservedClassForPath("/me/preferences")).toBeUndefined();
  });
});
