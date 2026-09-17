import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Two boundaries share this file because they guard the same name from two sides.
 *
 * - The Razorpay ADAPTER (`payments/adapters/razorpay.adapter.ts`) is the tenant-facing
 *   provider behind `PaymentProviderAdapterRegistry`.
 * - `RazorpayService` (`core/razorpay.service.ts`) is the platform's own subscription
 *   billing provider behind `PLATFORM_PAYMENT_PROVIDER`.
 *
 * Only `src/` is walked — the repository root holds `node_modules`, whose nested pnpm
 * symlinks form a cycle, and any registered git worktree under `.claude/`; walking it
 * failed the suite with `ELOOP` rather than an assertion. Paths are still reported from
 * the repository root, so every snapshot entry reads `src/modules/...`, the form somebody
 * can paste into an editor.
 */
const REPO_ROOT = join(__dirname, "../../../../");
const SRC_ROOT = join(REPO_ROOT, "src");
const ADAPTERS_DIR = join(__dirname, "adapters");
const RAZORPAY_SERVICE_DEF = join(__dirname, "../core/razorpay.service.ts");
const BILLING_SERVICE = join(__dirname, "../core/billing-payment-activation.ts");

/**
 * The composition root is allowed to name the adapter — that is where a provider
 * implementation is bound to the provider-neutral token. The sandbox verification
 * harness is the only other file allowed to, because proving the adapter's failure
 * mapping against the live sandbox means driving the adapter itself; it is a
 * standalone `pnpm verify:razorpay-sandbox` entry point, and the last assertion
 * below keeps it that way by refusing any import of it from the application.
 */
const COMPOSITION_ROOT = "src/modules/billing/payments/payments.module.ts";
const SANDBOX_VERIFIER = "src/scripts/verify-razorpay-sandbox.ts";
const ALLOWED_IMPORTERS = [COMPOSITION_ROOT, SANDBOX_VERIFIER];

/*
  Where naming the concrete platform provider is the point, not a leak.

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
const PLATFORM_COMPOSITION_ROOTS = [
  join(__dirname, "../core/billing.module.ts"),
  join(__dirname, "../core/platform-payment-registry.ts"),
];

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
  return /from\s+['"][^'"]*razorpay\.adapter['"]/.test(readFileSync(filePath, "utf8"));
}

function importsRazorpayService(filePath: string): boolean {
  return /from\s+['"][^'"]*razorpay\.service['"]/.test(readFileSync(filePath, "utf8"));
}

function isInsideAdaptersDir(filePath: string): boolean {
  return filePath.startsWith(ADAPTERS_DIR);
}

function isDefinitionFile(filePath: string): boolean {
  return filePath === RAZORPAY_SERVICE_DEF;
}

function isPlatformCompositionRoot(filePath: string): boolean {
  return PLATFORM_COMPOSITION_ROOTS.includes(filePath);
}

const allFiles = walkTs(SRC_ROOT);

describe("Razorpay adapter import boundary", () => {
  const importers = allFiles
    .filter(importsRazorpayAdapter)
    .filter((f) => !isInsideAdaptersDir(f))
    .map((f) => relative(REPO_ROOT, f).replace(/\\/g, "/"));

  it("scans a real population, so an empty violator list means something", () => {
    expect(allFiles.length).toBeGreaterThan(2_000);
    expect(allFiles).toContain(BILLING_SERVICE);
  });

  it("names a provider adapter that exists, so the boundary has a subject", () => {
    expect(allFiles).toContain(join(ADAPTERS_DIR, "razorpay.adapter.ts"));
  });

  it("billing-payment-activation.ts does not reach the Razorpay adapter", () => {
    expect(importers).not.toContain("src/modules/billing/core/billing-payment-activation.ts");
  });

  it("no production file outside the adapters directory imports it, bar the composition root", () => {
    const productionImporters = importers.filter(
      (f) => !f.endsWith(".spec.ts") && !f.endsWith("-spec.ts"),
    );

    expect(productionImporters.sort()).toEqual([...ALLOWED_IMPORTERS].sort());
  });

  it("the sandbox verifier stays a standalone entry point — nothing imports it", () => {
    const verifierImporters = allFiles
      .filter((f) => /from\s+['"][^'"]*verify-razorpay-sandbox['"]/.test(readFileSync(f, "utf8")))
      .map((f) => relative(REPO_ROOT, f).replace(/\\/g, "/"));

    expect(verifierImporters).toEqual([]);
  });

  it("keeps provider credential fields out of BillingPaymentActivation", () => {
    const billingSource = readFileSync(BILLING_SERVICE, "utf8");

    expect(billingSource).not.toMatch(/\b(?:keySecret|webhookSecret|RAZORPAY_KEY_SECRET)\b/);
  });

  it("documents every current importer so regressions are visible", () => {
    expect(importers.sort()).toMatchSnapshot();
  });
});

describe("RazorpayService import boundary", () => {
  const relativeViolators = allFiles
    .filter(importsRazorpayService)
    .filter((f) => !isDefinitionFile(f))
    .filter((f) => !isInsideAdaptersDir(f))
    .filter((f) => !isPlatformCompositionRoot(f))
    .map((f) => relative(REPO_ROOT, f).replace(/\\/g, "/"));

  it("names a platform provider that exists, so the boundary has a subject", () => {
    expect(allFiles).toContain(RAZORPAY_SERVICE_DEF);
  });

  it("billing-payment-activation.ts does not import RazorpayService", () => {
    expect(relativeViolators).not.toContain("src/modules/billing/core/billing-payment-activation.ts");
  });

  it("no production file outside billing/payments/adapters/ imports RazorpayService (test files excepted)", () => {
    const productionViolators = relativeViolators.filter((f) => !f.endsWith(".spec.ts") && !f.endsWith("-spec.ts"));
    expect(productionViolators).toEqual([]);
  });

  it("documents every current importer so regressions are visible", () => {
    expect(relativeViolators.sort()).toMatchSnapshot();
  });
});
