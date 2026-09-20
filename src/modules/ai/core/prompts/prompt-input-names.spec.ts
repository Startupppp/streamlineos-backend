import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROMPTS_DIR = __dirname;
const REQUEST_SCHEMAS = join(PROMPTS_DIR, "..", "dto", "request.schemas.ts");

function requestBodyTypeNames(): Set<string> {
  const source = readFileSync(REQUEST_SCHEMAS, "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/^export type (\w+) = z\.infer</gm)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

function promptArgumentTypeNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const file of readdirSync(PROMPTS_DIR)) {
    if (!file.endsWith(".prompts.ts")) continue;
    const source = readFileSync(join(PROMPTS_DIR, file), "utf8");
    for (const match of source.matchAll(/^export interface (\w+)/gm)) {
      const name = match[1];
      if (name !== undefined) names.set(name, file);
    }
  }
  return names;
}

describe("a prompt argument type never borrows the name of a request body type", () => {
  it("finds both sides, so an empty intersection is a real result rather than an empty scan", () => {
    expect(requestBodyTypeNames().size).toBeGreaterThan(20);
    expect(promptArgumentTypeNames().size).toBeGreaterThan(10);
  });

  it("keeps the two sets disjoint, because one name for the HTTP body and the assembled prompt lets an import from the wrong module typecheck", () => {
    const bodies = requestBodyTypeNames();
    const collisions = [...promptArgumentTypeNames()]
      .filter(([name]) => bodies.has(name))
      .map(([name, file]) => `${name} (${file})`);

    expect(collisions).toEqual([]);
  });
});
