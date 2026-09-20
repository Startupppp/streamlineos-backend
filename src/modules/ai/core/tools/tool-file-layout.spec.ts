import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TOOLS_DIR = __dirname;
const CORE_DIR = join(TOOLS_DIR, "..");

function toolFiles(): string[] {
  return readdirSync(TOOLS_DIR).filter(
    (entry) => entry.endsWith("-tools.ts") && !entry.endsWith(".spec.ts"),
  );
}

describe("every Ask OS tool provider lives in one folder, and that folder holds nothing but providers", () => {
  it("finds the providers, so the assertions below cannot pass over an empty directory", () => {
    expect(toolFiles().length).toBeGreaterThan(10);
  });

  it("leaves no tool file behind in core/, because a provider nobody can find is a provider nobody reuses", () => {
    const strays = readdirSync(CORE_DIR).filter(
      (entry) => entry.endsWith("-tools.ts") && !entry.endsWith(".spec.ts"),
    );

    expect(strays).toEqual([]);
  });

  it("exports only its provider class, so a helper another tool needs is never reachable through a tool definition", () => {
    const leaking = toolFiles().filter((entry) => {
      const source = readFileSync(join(TOOLS_DIR, entry), "utf8");
      return /^export (?!class\b)(const|function|interface|type|async)/m.test(source);
    });

    expect(leaking).toEqual([]);
  });

  it("keeps a real lib beside them, so the next shared helper has an obvious home that is not a tool file", () => {
    const lib = join(TOOLS_DIR, "lib");

    expect(statSync(lib).isDirectory()).toBe(true);
    expect(readdirSync(lib).filter((entry) => entry.endsWith(".ts")).length).toBeGreaterThan(0);
  });
});
