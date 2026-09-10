import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith(".ts")) continue;
      if (/\.(spec|e2e-spec)\.ts$/.test(full)) continue;
      found.push(full);
    }
  };
  walk(resolve(__dirname, "..", root));
  return found;
}

describe("the team scope fast path", () => {
  const modules = sourceFiles("");
  const callers = modules.filter((file) => {
    if (file.endsWith("apply-scope.ts")) return false;
    return readFileSync(file, "utf8").includes("applyScope(");
  });

  it("scans a real corpus, so an empty result is a finding rather than a broken walk", () => {
    expect(modules.length).toBeGreaterThan(500);
  });

  // ADR 0005: applyScope became internal, so ScopedRead is the only thing that can call it.
  it("has exactly one caller, and it is the scoped-read seam", () => {
    expect(callers).toHaveLength(1);
    expect(callers[0]?.endsWith("scoped-read.ts")).toBe(true);
  });

  // Only a ScopeColumns literal can supply teamIds, and those name ownerColumn beside it.
  it("no scope spec supplies teamIds yet — team scope falls back to own, not a subquery", () => {
    const supplying = modules
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return source.includes("ownerColumn") && /teamIds\s*:/.test(source);
      })
      .map((file) => file.split("modules")[1] ?? file);

    expect(supplying).toEqual([]);
  });
});
