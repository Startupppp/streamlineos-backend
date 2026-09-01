import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const TIMESHEETS_DIR = join(__dirname, "..");

function walkControllers(dir: string): string[] {
  const files: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (statSync(p).isDirectory()) files.push(...walkControllers(p));
    else if (e.name.endsWith(".controller.ts") && !e.name.endsWith(".spec.ts")) files.push(p);
  }
  return files;
}

describe("Timesheets module gate (D1 fix)", () => {
  const controllers = walkControllers(TIMESHEETS_DIR);

  it("finds at least 14 controller files", () => {
    expect(controllers.length).toBeGreaterThanOrEqual(14);
  });

  it.each(controllers)("%s: no controller gates on @RequireModule('build') at class level", (file) => {
    const content = readFileSync(file, "utf8");
    const wrongGate = content.match(/@RequireModule\("build"\)(?:\s*(?:@[A-Za-z$_][A-Za-z0-9$_]*(?:\([^)]*\))?\s*))*export\s+(?:abstract\s+)?class\s/);
    expect(wrongGate).toBeNull();
  });

  it.each(controllers)("%s: every non-public controller gates on @RequireModule('timesheets') at class level", (file) => {
    const content = readFileSync(file, "utf8");
    const isClassPublic = /@Public\(\)(?:\s*(?:@[A-Za-z$_][A-Za-z0-9$_]*(?:\([^)]*\))?\s*))*export\s+(?:abstract\s+)?class\s/.test(content);
    if (isClassPublic) return;
    const hasCorrectGate = content.match(/@RequireModule\("timesheets"\)(?:\s*(?:@[A-Za-z$_][A-Za-z0-9$_]*(?:\([^)]*\))?\s*))*export\s+(?:abstract\s+)?class\s/);
    expect(hasCorrectGate).not.toBeNull();
  });
});
