import { readFileSync } from "node:fs";
import { join } from "node:path";

const QA_DIR = join(__dirname, "..");

function read(file: string): string {
  return readFileSync(join(QA_DIR, file), "utf8");
}

const CONTROLLER = read("test-runs.controller.ts");
const SERVICE = read("test-runs.service.ts");

describe("the legacy build.bugs writer is unreachable from any HTTP route", () => {
  it("still declares the legacy createBugFromResult, so b-qa-bug-04-contract-freeze has something to freeze", () => {
    expect(SERVICE).toContain("createBugFromResult(");
    expect(SERVICE).toContain(".insert(bugs)");
  });

  it("routes the bug-from-result endpoint at the consolidated work-item path", () => {
    expect(CONTROLLER).toContain("createBugFromResultConsolidated");
  });

  it("names no legacy createBugFromResult call anywhere in the controller, so no request reaches insert(bugs)", () => {
    const legacyCalls = CONTROLLER.match(/\.createBugFromResult\s*\(/g) ?? [];
    expect(legacyCalls).toHaveLength(0);
  });

  it("keeps insert(bugs) confined to the one frozen method rather than spreading to the consolidated path", () => {
    const consolidated = SERVICE.slice(SERVICE.indexOf("createBugFromResultConsolidated("));
    expect(consolidated).not.toContain(".insert(bugs)");
  });
});
