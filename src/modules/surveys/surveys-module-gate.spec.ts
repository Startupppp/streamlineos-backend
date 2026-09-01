import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SURVEYS_DIR = __dirname;

function walkControllers(dir: string): string[] {
  const files: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (statSync(p).isDirectory()) files.push(...walkControllers(p));
    else if (e.name.endsWith(".controller.ts") && !e.name.endsWith(".spec.ts")) files.push(p);
  }
  return files;
}

describe("Surveys module gate (D2 fix)", () => {
  const controllers = walkControllers(SURVEYS_DIR);

  it("finds at least 9 controller files", () => {
    expect(controllers.length).toBeGreaterThanOrEqual(9);
  });

  it.each(controllers)("%s: non-public controllers gate on @RequireModule('surveys') at class level", (file) => {
    const content = readFileSync(file, "utf8");
    const isClassPublic = /@Public\(\)(?:\s*(?:@[A-Za-z$_][A-Za-z0-9$_]*(?:\([^)]*\))?\s*))*export\s+(?:abstract\s+)?class\s/.test(content);
    if (isClassPublic) return;
    const allMethodsPublic = (() => {
      const handlers = [...content.matchAll(/@(?:Get|Post|Patch|Put|Delete)\(/g)];
      if (handlers.length === 0) return true;
      const publicHandlers = [...content.matchAll(/@Public\(\)[\s\S]{0,200}?@(?:Get|Post|Patch|Put|Delete)\(/g)];
      return publicHandlers.length >= handlers.length;
    })();
    if (allMethodsPublic) return;
    const hasCorrectGate = content.match(/@RequireModule\("surveys"\)(?:\s*(?:@[A-Za-z$_][A-Za-z0-9$_]*(?:\([^)]*\))?\s*))*export\s+(?:abstract\s+)?class\s/);
    expect(hasCorrectGate).not.toBeNull();
  });
});
