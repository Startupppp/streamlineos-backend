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
  const callers = sourceFiles("").filter((file) => {
    if (file.endsWith("apply-scope.ts")) return false;
    return readFileSync(file, "utf8").includes("applyScope(");
  });

  it("finds the call sites it is meant to be checking", () => {
    expect(callers.length).toBeGreaterThan(20);
  });

  it("no caller supplies teamIds yet — team scope falls back to own, not a subquery", () => {
    const supplying = callers
      .filter((file) => readFileSync(file, "utf8").includes("teamIds"))
      .map((file) => file.split("modules")[1] ?? file);

    expect(supplying).toEqual([]);
  });
});
