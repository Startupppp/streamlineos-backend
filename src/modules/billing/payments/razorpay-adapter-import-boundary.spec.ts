import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The provider boundary: nothing outside `billing/payments/adapters/` depends on
 * a concrete payment provider.
 *
 * THIS SPEC WAS GUARDING A FILE THAT NO LONGER EXISTS. It looked for importers
 * of `razorpay.service`, which was replaced by `adapters/razorpay.adapter.ts` in
 * the provider-adapter refactor. So `violators` was necessarily empty, the
 * snapshot recorded `[]`, and all four assertions passed over nothing — a gate
 * whose subject had been deleted out from under it.
 *
 * Two separate defects kept that invisible in opposite directions. The walk
 * started at the repository root and descended into `node_modules`, where
 * pnpm's self-referential links made `statSync` die `ELOOP` after thirty-odd
 * `node_modules/node_modules/...` segments — so the suite failed to run, and a
 * suite that fails to run is not a suite anybody reads the assertions of. Fixing
 * only that would have turned a loud crash into a quiet, permanent green.
 *
 * The boundary itself is still real, so this now asserts it against the file
 * that exists.
 */

const REPO_ROOT = join(__dirname, "../../../../");
const WALK_ROOT = join(REPO_ROOT, "src");
const ADAPTERS_DIR = join(__dirname, "adapters");
const BILLING_SERVICE = join(__dirname, "../core/billing-payment-activation.ts");

/**
 * The one production importer outside `adapters/` that must exist: a Nest module
 * cannot register a provider it may not name. Everything else depends on
 * `PaymentProviderAdapter`, the interface.
 */
const DI_REGISTRATION = "src/modules/billing/payments/payments.module.ts";

/**
 * The one operator script that must name the concrete provider: it is the live
 * half of the Razorpay failure proof, so it constructs `RazorpayAdapter` against
 * the real sandbox on purpose. It is named by path rather than by admitting
 * `src/scripts/` wholesale, so a second script reaching for the provider still
 * fails this suite.
 */
const SANDBOX_VERIFIER = "src/scripts/verify-razorpay-sandbox.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".next"]);

function walkTs(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walkTs(full));
    else if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

function importsRazorpayAdapter(filePath: string): boolean {
  const content = readFileSync(filePath, "utf8");
  return /from\s+['"][^'"]*razorpay\.adapter['"]/.test(content);
}

function isInsideAdaptersDir(filePath: string): boolean {
  return filePath.startsWith(ADAPTERS_DIR);
}

describe("payment provider import boundary", () => {
  const allFiles = walkTs(WALK_ROOT);
  const relativeImporters = allFiles
    .filter(importsRazorpayAdapter)
    .filter((f) => !isInsideAdaptersDir(f))
    .map((f) => relative(REPO_ROOT, f).replace(/\\/g, "/"))
    .sort();

  it("walked the source tree and found the file it is about", () => {
    /*
     * Every assertion below is a filter over `allFiles`, so a walk returning
     * nothing satisfies all of them. That is not hypothetical here: this suite
     * spent the adapter refactor asserting things about a filename that had
     * stopped existing, and passed each time.
     */
    expect(allFiles.length).toBeGreaterThan(500);
    expect(allFiles.some((f) => f.endsWith(join("adapters", "razorpay.adapter.ts")))).toBe(true);
  });

  it("keeps the concrete provider out of everything but its own directory, the module that wires it and the sandbox verifier", () => {
    const production = relativeImporters.filter((f) => !f.endsWith(".spec.ts") && !f.endsWith("-spec.ts"));
    expect(production).toEqual([DI_REGISTRATION, SANDBOX_VERIFIER]);
  });

  it("billing-payment-activation.ts does not reach for the provider directly", () => {
    expect(relativeImporters).not.toContain("src/modules/billing/core/billing-payment-activation.ts");
  });

  it("keeps provider credential fields out of BillingPaymentActivation", () => {
    const billingSource = readFileSync(BILLING_SERVICE, "utf8");
    expect(billingSource).not.toMatch(/\b(?:keySecret|webhookSecret|RAZORPAY_KEY_SECRET)\b/);
  });

  it("documents every current importer so a new one is visible", () => {
    expect(relativeImporters).toMatchSnapshot();
  });
});
