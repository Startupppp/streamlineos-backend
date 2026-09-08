import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * PRD-C073 — "Implement existence/authorization probes with tenant-correlated indexed
 * predicates and `LIMIT 1`; do not fetch records or counts when only existence is required."
 *
 * The record half was already enforced by `existence-paths.mjs`. The COUNT half was not
 * enforced anywhere, and it is the expensive one: 21 sites in `src/modules` ran an
 * unbounded `count()` aggregate whose value was only ever compared against 0 or 1. The
 * worst counted every POSTED journal entry in the organisation to decide whether the base
 * currency may still change.
 *
 * This spec pins both halves of the fix: the sites are rewritten, and the detector that
 * keeps them rewritten actually draws the distinction it claims to.
 */
const SCRIPTS_DIR = __dirname;
const SRC_ROOT = resolve(SCRIPTS_DIR, "..");

/** The sites rewritten for C073, and the shape each must keep. */
const REWRITTEN = [
  "modules/accounting/settings/accounting-settings.service.ts",
  "modules/module-access/module-access-group-crud.service.ts",
  "modules/payroll/setup/components.service.ts",
  "modules/payroll/runs/exceptions.service.ts",
  "modules/hr/governance/positions/positions-taxonomy.service.ts",
  "modules/organization/core/org-membership-access-revocation.ts",
  "modules/hr/onboarding/flow/hr-checklist-signals.ts",
];

function scanRepo(): { inScope: string[]; deferred: string[] } {
  const program = `
    import { readdirSync, statSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    import { scanCountExistenceProbes, OUT_OF_RELEASE_SCOPE } from ${JSON.stringify(pathToFileURL(join(SCRIPTS_DIR, "count-existence-probes.mjs")).href)};
    const ROOT = ${JSON.stringify(SRC_ROOT)};
    const files = [];
    (function walk(d) {
      for (const e of readdirSync(d)) {
        const f = join(d, e);
        const st = statSync(f);
        if (st.isDirectory()) { if (e !== "node_modules") walk(f); }
        else if (f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.includes(".spec.")) files.push(f);
      }
    })(ROOT);
    const inScope = [], deferred = [];
    for (const f of files) {
      const rel = f.slice(ROOT.length);
      for (const x of scanCountExistenceProbes(rel, readFileSync(f, "utf8")))
        (OUT_OF_RELEASE_SCOPE.test(rel) ? deferred : inScope).push(rel + ":" + x.line + " (" + x.binding + ")");
    }
    process.stdout.write(JSON.stringify({ inScope, deferred, files: files.length }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(out) as { inScope: string[]; deferred: string[]; files: number };
  expect(parsed.files).toBeGreaterThan(2000);
  return parsed;
}

describe("unbounded COUNT existence probes (PRD-C073)", () => {
  it("no in-scope module answers a yes/no question with an unbounded count()", () => {
    const { inScope } = scanRepo();
    expect(inScope).toEqual([]);
  });

  it.each(REWRITTEN)("%s bounds its existence probe with a LIMIT", (rel) => {
    const source = readFileSync(join(SRC_ROOT, rel), "utf8");
    expect(source).toMatch(/\.limit\(/);
    expect(source).toMatch(/select\(\{\s*one:\s*sql`1`\s*\}\)/);
  });

  it("check:query-projections enforces the rule and its self-test proves the distinction", () => {
    const selfTest = execFileSync(
      process.execPath,
      [join(SCRIPTS_DIR, "check-query-projections.mjs"), "--self-test"],
      { encoding: "utf8" },
    );
    expect(selfTest).toMatch(/SELF-TEST PASS/);

    const run = execFileSync(process.execPath, [join(SCRIPTS_DIR, "check-query-projections.mjs")], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(run).toMatch(/Unbounded COUNT existence probes \(count\(\) vs 0\/1, no LIMIT\): 0 in scope \(allowed 0\)/);
  });

  it("the rule is enforced at a literal zero, not against a re-emittable baseline", () => {
    const gate = readFileSync(join(SCRIPTS_DIR, "check-query-projections.mjs"), "utf8");
    expect(gate).toMatch(/if \(countProbesInScope\.length > 0\)/);
    expect(gate).not.toMatch(/countProbesAllowed/);
  });
});
