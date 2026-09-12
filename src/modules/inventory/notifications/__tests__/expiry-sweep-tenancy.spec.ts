import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * G3 — the sweep's tenancy boundary, guarded against its own history.
 *
 * `sweepAll` writes into every organisation on the platform. `sweepOrg` writes
 * into one. The first version of the endpoint called the all-tenant sweep
 * behind `inventory:settings:manage`, which is tenant-scoped — so one
 * organisation's inventory administrator could drive work and write
 * `inventory.lot.expiring` events into organisations they have no relationship
 * with, and the `{ organizations }` count in the response disclosed the size of
 * the platform on its own.
 *
 * That was fixed by splitting the two methods. Nothing stopped it coming back:
 * the all-tenant method still exists, still has no caller, and is one edit away
 * from being wired to a handler again — which is exactly how it happened the
 * first time, by copying an endpoint and dropping its `u.orgId`.
 *
 * This asserts the shape rather than a code path, for the reason the module's
 * ledger guard gives: a mock proves one route is scoped, the source proves
 * there is no route that is not.
 */

const INVENTORY = join(__dirname, "..", "..");

function filesUnder(dir: string, predicate: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, predicate));
    else if (predicate(entry)) out.push(full);
  }
  return out;
}

/**
 * Comments are prose, not code.
 *
 * The controller's own comment describes the hole this guards, and a scan that
 * does not strip comments finds that description and reports the defect it is
 * quoting. The stripper is asserted below rather than assumed — this module has
 * shipped a guard that read its own documentation as evidence.
 */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("G3 expiry sweep tenancy", () => {
  it("strips comments, so it cannot read the controller's own explanation as code", () => {
    const code = codeOf(join(INVENTORY, "notifications", "inv-expiry-sweep.controller.ts"));

    expect(code).not.toContain("cross-tenant hole");
    expect(code).toContain("sweepOrg");
  });

  /**
   * The endpoint sweeps the caller's organisation, named from the token — never
   * an org id off the request, and never every organisation.
   */
  it("passes the caller's own org id to the single-organisation sweep", () => {
    const code = codeOf(join(INVENTORY, "notifications", "inv-expiry-sweep.controller.ts"));

    expect(code).toMatch(/sweep\.sweepOrg\(\s*u\.orgId\s*\)/);
  });

  it("exposes no HTTP handler that reaches the all-tenant sweep", () => {
    const controllers = filesUnder(INVENTORY, (name) => name.endsWith(".controller.ts"));
    expect(controllers.length).toBeGreaterThan(0);

    const offenders = controllers.filter((file) => /\bsweepAll\b/.test(codeOf(file)));

    expect(offenders.map((f) => f.slice(INVENTORY.length + 1))).toEqual([]);
  });

  /**
   * The all-tenant sweep is allowed to exist — a scheduler will want it — but it
   * must stay something only a scheduler can reach. If a caller appears outside
   * the service that declares it, this test is the place to decide whether that
   * caller is a scheduler or a repeat of the original hole.
   */
  it("keeps the all-tenant sweep without a caller anywhere in inventory", () => {
    const sources = filesUnder(
      INVENTORY,
      (name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"),
    ).filter((file) => !file.endsWith("inv-expiry-sweep.service.ts"));

    const callers = sources.filter((file) => /\.sweepAll\s*\(/.test(codeOf(file)));

    expect(callers.map((f) => f.slice(INVENTORY.length + 1))).toEqual([]);
  });
});
