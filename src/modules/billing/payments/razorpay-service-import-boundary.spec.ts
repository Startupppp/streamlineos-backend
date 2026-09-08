import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(__dirname, "../../../../");
const SRC_ROOT = join(REPO_ROOT, "src");
const ADAPTERS_DIR = join(__dirname, "adapters");
const BILLING_SERVICE = join(__dirname, "../core/billing.service.ts");

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

function isInsideAdaptersDir(filePath: string): boolean {
  return filePath.startsWith(ADAPTERS_DIR);
}

describe("Razorpay adapter import boundary", () => {
  const allFiles = walkTs(SRC_ROOT);
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

  it("billing.service.ts does not reach the Razorpay adapter", () => {
    expect(importers).not.toContain("src/modules/billing/core/billing.service.ts");
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

  it("keeps provider credential fields out of BillingService", () => {
    const billingSource = readFileSync(BILLING_SERVICE, "utf8");

    expect(billingSource).not.toMatch(/\b(?:keySecret|webhookSecret|RAZORPAY_KEY_SECRET)\b/);
  });

  it("documents every current importer so regressions are visible", () => {
    expect(importers.sort()).toMatchSnapshot();
  });
});
