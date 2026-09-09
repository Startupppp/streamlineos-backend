import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * `src/`, not the repository root.
 *
 * This was one `..` too many, so `walkTs` recursed the whole checkout —
 * `node_modules`, whose nested pnpm symlinks form a cycle, and any registered
 * git worktree under `.claude/`. The suite did not fail an assertion; it failed
 * to run at all, with `ELOOP: too many symbolic links`, which reads like an
 * environment problem rather than the off-by-one it is. There is nothing to scan
 * for a Razorpay import outside our own source anyway.
 */
const SRC_ROOT = join(__dirname, "../../../");
/**
 * Paths are reported from the repository root even though only `src/` is walked,
 * so the snapshot reads `src/modules/...` — the form somebody can paste into an
 * editor. Deriving it from `SRC_ROOT` would have rewritten every entry, and a
 * snapshot that moves when the scan is fixed is a snapshot that would not have
 * noticed a real importer appearing.
 */
const REPO_ROOT = join(SRC_ROOT, "..");
const ADAPTERS_DIR = join(__dirname, "adapters");
const RAZORPAY_SERVICE_DEF = join(__dirname, "../core/razorpay.service.ts");
const BILLING_SERVICE = join(__dirname, "../core/billing.service.ts");

function walkTs(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkTs(full));
    } else if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function importsRazorpayService(filePath: string): boolean {
  const content = readFileSync(filePath, "utf8");
  return /from\s+['"][^'"]*razorpay\.service['"]/.test(content);
}

function isInsideAdaptersDir(filePath: string): boolean {
  return filePath.startsWith(ADAPTERS_DIR);
}

function isDefinitionFile(filePath: string): boolean {
  return filePath === RAZORPAY_SERVICE_DEF;
}

/*
  Where naming the concrete provider is the point, not a leak.

  This guard exists so a SERVICE cannot reach past the abstraction and talk to
  Razorpay directly. A composition root is the opposite case: binding
  `PLATFORM_PAYMENT_PROVIDER` to an implementation is the one place that has to
  name one, and doing it there is what keeps every other file from having to.
  `billing.module.ts` does exactly that (`useExisting: RazorpayService`), and
  `platform-payment-registry.ts` selects between implementations, which is the
  same job one level up.

  The rule that matters is unchanged and asserted separately below:
  `billing.service.ts` must not import it. If either file below ever grows logic
  beyond wiring, it stops being a composition root and belongs back in the list.
*/
const COMPOSITION_ROOTS = [
  join(__dirname, "../core/billing.module.ts"),
  join(__dirname, "../core/platform-payment-registry.ts"),
];

function isCompositionRoot(filePath: string): boolean {
  return COMPOSITION_ROOTS.includes(filePath);
}

describe("RazorpayService import boundary", () => {
  const allFiles = walkTs(SRC_ROOT);
  const violators = allFiles
    .filter(importsRazorpayService)
    .filter((f) => !isDefinitionFile(f))
    .filter((f) => !isInsideAdaptersDir(f))
    .filter((f) => !isCompositionRoot(f));

  const relativeViolators = violators.map((f) => relative(REPO_ROOT, f).replace(/\\/g, "/"));

  it("billing.service.ts does not import RazorpayService", () => {
    expect(relativeViolators).not.toContain("src/modules/billing/core/billing.service.ts");
  });

  it("no production file outside billing/payments/adapters/ imports RazorpayService (test files excepted)", () => {
    const productionViolators = relativeViolators.filter((f) => !f.endsWith(".spec.ts") && !f.endsWith("-spec.ts"));
    expect(productionViolators).toEqual([]);
  });

  it("keeps provider credential fields out of BillingService", () => {
    const billingSource = readFileSync(BILLING_SERVICE, "utf8");

    expect(billingSource).not.toMatch(/\b(?:keySecret|webhookSecret|RAZORPAY_KEY_SECRET)\b/);
  });

  it("documents every current importer so regressions are visible", () => {
    expect(relativeViolators.sort()).toMatchSnapshot();
  });
});
