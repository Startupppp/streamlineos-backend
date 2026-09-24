import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CORE = join(__dirname, "..");

function controllers(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...controllers(full));
    else if (entry.endsWith(".controller.ts")) out.push(full);
  }
  return out;
}

describe("the unscoped entry read", () => {
  it("is named so its own signature warns the next caller", () => {
    const source = readFileSync(join(CORE, "entries-read.service.ts"), "utf8");
    expect(source).toContain("async getEntryUnscoped(");
    expect(source).not.toContain("async getEntryById(");
  });

  it("has exactly the two post-write callers, and no others", () => {
    const source = readFileSync(join(CORE, "entries.service.ts"), "utf8");
    const calls = source.match(/this\.reader\.getEntryUnscoped\(/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(source).not.toMatch(/^\s{2}getEntryUnscoped\(/m);
  });

  it("is not reachable from any timesheets controller", () => {
    const offenders = controllers(CORE).filter((file) =>
      /getEntryUnscoped|getEntryById/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
