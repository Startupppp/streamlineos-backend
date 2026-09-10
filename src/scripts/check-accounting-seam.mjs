/**
 * The accounting-seam pack's definition of done, as a gate.
 *
 * Most of the pack's P0 work is defended by its own specs, and duplicating
 * those here would be theatre. What this checks is the set of invariants that
 * have **no other guardian** — the ones a test suite cannot express because
 * they are about the shape of the repository rather than the behaviour of a
 * function:
 *
 *   (a) the orchestrator's fence: accounting may not reach into HR, Payroll or
 *       PMS/Build, which nothing anywhere asserts;
 *   (b) the design decision the pack argued and rejected has not crept back in
 *       through a side door;
 *   (c) the artefact each delivered ticket produced is still on disk and carries
 *       assertions — a deleted spec is a silently satisfied requirement, and
 *       this repo has been bitten by exactly that;
 *   (d) the contract those decisions live in is checked in beside the code.
 *
 * Usage:  node src/scripts/check-accounting-seam.mjs [--self-test]
 * Exit:   0 clean · 1 a violation · 2 prerequisite unmet
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const SRC = join(BACKEND_ROOT, "src");
const ACCOUNTING = join(SRC, "modules/accounting");

/** Module folders the orchestrator forbids this pack from touching. */
const FENCED = ["modules/hr", "modules/payroll", "modules/build", "db/schema/hr", "db/schema/payroll", "db/schema/build"];

/**
 * Each delivered ticket and the artefact that proves it, with the least number
 * of assertions that artefact must still carry.
 *
 * The count is a floor against erosion, not a target. A spec trimmed to one
 * assertion still passes CI and still reports the requirement as met, which is
 * the failure mode this list exists to catch.
 *
 * The P1s and the P2 are in here on the same terms as the P0s. A priority is a
 * statement about what to do first, not about what may quietly rot afterwards,
 * and the reconciliation reports and the compliance honesty rules are the parts
 * of this pack a future change is most likely to erode without meaning to.
 */
const PACK_ARTEFACTS = [
  { ticket: "ACC-01", path: "docs/inventory-gl-contract.md", minAssertions: 0 },
  { ticket: "ACC-02", path: "src/modules/accounting/setup/accounting-provisioning.spec.ts", minAssertions: 6 },
  { ticket: "ACC-03", path: "src/modules/accounting/kernel/system-tag-roles.spec.ts", minAssertions: 10 },
  { ticket: "ACC-05", path: "src/modules/accounting/adapters/inventory-post-atomicity.spec.ts", minAssertions: 3 },
  { ticket: "ACC-06", path: "src/modules/accounting/adapters/posting-rejections-over-http.spec.ts", minAssertions: 5 },
  { ticket: "ACC-07", path: "src/modules/accounting/adapters/inventory-posting-keys.spec.ts", minAssertions: 4 },
  { ticket: "ACC-08", path: "src/modules/accounting/adapters/reconciliation/unposted-movements.spec.ts", minAssertions: 10 },
  { ticket: "ACC-10", path: "src/modules/accounting/parties/accounting-party-only.spec.ts", minAssertions: 5 },
  { ticket: "ACC-12", path: "src/modules/accounting/compliance/compliance-honesty.spec.ts", minAssertions: 8 },
  { ticket: "ACC-16", path: "src/modules/accounting/adapters/accounting-disabled-tenant.spec.ts", minAssertions: 5 },
  { ticket: "ACC-19", path: "src/modules/accounting/adapters/ledger-boundary.spec.ts", minAssertions: 8 },
  { ticket: "ACC-09", path: "src/modules/accounting/adapters/reconciliation/stock-gl-reconciliation.spec.ts", minAssertions: 14 },
  { ticket: "ACC-13", path: "src/modules/accounting/compliance/transport/compliance-transport.spec.ts", minAssertions: 30 },
  { ticket: "ACC-15", path: "src/modules/accounting/adapters/posting-refusals.spec.ts", minAssertions: 14 },
  { ticket: "ACC-17", path: "src/modules/accounting/adapters/document-series-fy.spec.ts", minAssertions: 10 },
  { ticket: "ACC-18", path: "docs/adr-legacy-invoices-vs-ar.md", minAssertions: 0 },
];

/** Headings the contract must still carry, because commits cite them by number. */
const CONTRACT_ANCHORS = [
  "Atomicity is inherited, not declared",
  "The hole that was real: ten movements that posted nothing",
  "The decision: fail closed",
];

function tsFilesUnder(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path).flatMap((entry) => {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) return tsFilesUnder(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/* ─────────────────────────────────────────────────────────── the checks ── */

/**
 * (a) Accounting must not import from a fenced module.
 *
 * The arrow that IS allowed runs the other way: payroll and expenses call
 * `PostingCommandService`, which is the anti-corruption layer working as
 * designed. Accounting importing payroll would invert it and make the ledger
 * depend on the thing it is supposed to be insulated from.
 */
function checkFence(files) {
  const violations = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      /*
        Resolved, not pattern-matched. From `modules/accounting/kernel/x.ts`
        payroll is `../../payroll/...` and contains the word "modules" nowhere
        — a regex looking for `modules/payroll/` would have found nothing
        forever, which is exactly what the self-test caught when this gate was
        first written.
      */
      if (!specifier.startsWith(".")) continue;
      const target = relative(SRC, resolve(dirname(file), specifier)).replace(/\\/g, "/");
      const fenced = FENCED.find((folder) => target === folder || target.startsWith(`${folder}/`));
      if (fenced) violations.push(`${relative(SRC, file)} imports from ${fenced}`);
    }
  }
  return violations;
}

/** Every module specifier in a file, import or re-export, type or value. */
function importSpecifiers(source) {
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
}

/**
 * (b) `pending_accounting` was considered and rejected in the contract's §4.
 *
 * The argument against it is that it needs a queue, a retry, a dead-letter and
 * an operator surface to make one existing failure quieter, and that every
 * report drawn between enqueue and drain is wrong in a way no reader can
 * detect. If somebody reintroduces it, that has to be a decision that revisits
 * §4, not a state that appears.
 */
function checkRejectedDesign(files) {
  return files
    .filter((file) => /pending_accounting|pendingAccounting/.test(readFileSync(file, "utf8")))
    .map((file) => `${relative(SRC, file)} introduces a pending_accounting state`);
}

/** (c) Each delivered ticket's artefact is present and still carries assertions. */
function checkArtefacts() {
  const violations = [];
  for (const { ticket, path, minAssertions } of PACK_ARTEFACTS) {
    const full = join(BACKEND_ROOT, path);
    if (!existsSync(full)) {
      violations.push(`${ticket}: ${path} is gone`);
      continue;
    }
    if (minAssertions === 0) continue;

    const source = readFileSync(full, "utf8");
    const assertions = (source.match(/\bexpect\(/g) ?? []).length;
    if (assertions < minAssertions) {
      violations.push(
        `${ticket}: ${path} has ${assertions} assertions, below its floor of ${minAssertions}`,
      );
    }
  }
  return violations;
}

/** (d) The contract still says what the commits say it says. */
function checkContract() {
  const path = join(BACKEND_ROOT, "docs/inventory-gl-contract.md");
  if (!existsSync(path)) return ["docs/inventory-gl-contract.md is gone"];

  const source = readFileSync(path, "utf8");
  return CONTRACT_ANCHORS.filter((anchor) => !source.includes(anchor)).map(
    (anchor) => `the contract no longer contains "${anchor}"`,
  );
}

/* ───────────────────────────────────────────────────────────── self-test ── */

function selfTest() {
  const cases = [
    {
      /*
        Both directions, because the first version of this check passed the
        clean case and could never have failed the dirty one. The dirty case is
        written the way a real import is written — relative, with no "modules"
        segment in it at all.
      */
      name: "fence resolves a relative import into a fenced folder",
      run: () => checkFence([join(ACCOUNTING, "kernel/ledger.service.ts")]).length === 0,
      thenBroken: () => {
        const pretendFile = join(ACCOUNTING, "kernel/pretend.ts");
        const specifier = "../../payroll/payroll-posting.service";
        const target = relative(SRC, resolve(dirname(pretendFile), specifier)).replace(/\\/g, "/");
        return FENCED.some((folder) => target.startsWith(`${folder}/`));
      },
    },
    {
      name: "rejected design is detected by name",
      run: () => /pending_accounting/.test("const s = 'pending_accounting';"),
      thenBroken: () => !/pending_accounting/.test("const s = 'posted';"),
    },
    {
      name: "an artefact floor notices a gutted spec",
      run: () => ("expect(1).toBe(1);".match(/\bexpect\(/g) ?? []).length === 1,
      thenBroken: () => (("".match(/\bexpect\(/g) ?? []).length) === 0,
    },
  ];

  let failed = 0;
  for (const testCase of cases) {
    const ok = testCase.run() && testCase.thenBroken();
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${testCase.name}`);
    if (!ok) failed += 1;
  }
  console.log(failed === 0 ? "\nSELF-TEST OK" : `\nSELF-TEST FAILED (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

/* ────────────────────────────────────────────────────────────────── main ── */

if (process.argv.includes("--self-test")) selfTest();

if (!existsSync(ACCOUNTING)) {
  console.error("PREREQUISITE UNMET: src/modules/accounting does not exist in this checkout.");
  process.exit(2);
}

const accountingFiles = tsFilesUnder(ACCOUNTING).filter(
  (f) => !f.endsWith(".spec.ts") && !f.endsWith(".e2e-spec.ts"),
);

if (accountingFiles.length < 50) {
  /*
    A floor, not a formality. Every check below reports "clean" over an empty
    list, so a moved directory would turn this gate into a green light for
    nothing at all.
  */
  console.error(
    `PREREQUISITE UNMET: only ${accountingFiles.length} accounting source files found; the scan is not reaching the module.`,
  );
  process.exit(2);
}

const findings = [
  ...checkFence(accountingFiles),
  ...checkRejectedDesign(accountingFiles),
  ...checkArtefacts(),
  ...checkContract(),
];

console.log(`Accounting source files scanned   ${accountingFiles.length}`);
console.log(`Pack artefacts checked            ${PACK_ARTEFACTS.length}`);
console.log("");

if (findings.length > 0) {
  console.log("VIOLATIONS:");
  for (const finding of findings) console.log(`  FAIL  ${finding}`);
  console.log(`\nFAIL — ${findings.length} accounting-seam violation(s).`);
  process.exit(1);
}

console.log("OK — the fence holds, no rejected design has returned, and every artefact stands.");
process.exit(0);
