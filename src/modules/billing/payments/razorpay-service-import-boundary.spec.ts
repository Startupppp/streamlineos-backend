import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(__dirname, "../../../../");
const ADAPTERS_DIR = join(__dirname, "adapters");
const RAZORPAY_SERVICE_DEF = join(__dirname, "../core/razorpay.service.ts");

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

describe("RazorpayService import boundary", () => {
  const allFiles = walkTs(SRC_ROOT);
  const violators = allFiles
    .filter(importsRazorpayService)
    .filter((f) => !isDefinitionFile(f))
    .filter((f) => !isInsideAdaptersDir(f));

  const relativeViolators = violators.map((f) => relative(SRC_ROOT, f).replace(/\\/g, "/"));

  it("billing.service.ts does not import RazorpayService", () => {
    expect(relativeViolators).not.toContain("src/modules/billing/core/billing.service.ts");
  });

  it("no production file outside billing/payments/adapters/ imports RazorpayService (test files excepted)", () => {
    const productionViolators = relativeViolators.filter((f) => !f.endsWith(".spec.ts") && !f.endsWith("-spec.ts"));
    expect(productionViolators).toEqual([]);
  });

  it("documents every current importer so regressions are visible", () => {
    expect(relativeViolators.sort()).toMatchSnapshot();
  });
});
