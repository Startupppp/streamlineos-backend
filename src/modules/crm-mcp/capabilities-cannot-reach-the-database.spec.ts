import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { ACTIVITY_KINDS } from "../../db/schema/crm/activities";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";
import { CRM_CAPABILITIES } from "./capabilities/crm-capabilities";
import { MCP_ACTIVITY_KINDS } from "./dto/crm-mcp.schemas";

/**
 * The guard behind ticket 19's fourth criterion.
 *
 * "The protocol layer never reaches past the service boundary" is the promise
 * that gets broken first, and it never gets broken by anyone arguing for it. It
 * breaks because a capability needs one field the service does not return, the
 * database handle is three imports away, and the diff is six lines. A code
 * review catches that once. It does not catch it the fourth time.
 *
 * So it is not a review question. This walks the VALUE import graph out of the
 * capability layer and fails if any path arrives at the database. Type-only
 * imports are not followed, deliberately and precisely: `CapabilityServices`
 * names three services with `import type`, so the capability layer knows their
 * SHAPES and holds none of their code — the instances arrive as an argument
 * from the executor. That is the whole trick, and it is the same one
 * `query-compiler.ts` uses for tenancy: the reach is not forbidden, it is
 * absent from the graph.
 *
 * At the time of writing, the entire reachable graph from the catalogue is four
 * files and the `zod` package.
 */
describe("a capability cannot reach past the services it is handed", () => {
  const CAPABILITY_DIR = "src/modules/crm-mcp/capabilities";

  const executable = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

  const IMPORT = /import\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
  /** `import "./x"` runs the module for its side effects, so it is a value edge. */
  const SIDE_EFFECT = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  /** `export … from "./x"` re-exports values and pulls the module in exactly as an import does. */
  const RE_EXPORT = /export\s+(?!type\b)[\s\S]*?\sfrom\s*["']([^"']+)["']/g;

  /**
   * What a file actually pulls in at runtime.
   *
   * `import type { X }` and `import { type X }` are erased by the compiler and
   * are therefore not edges. Missing that distinction would make this test
   * fail on `mcp-capability.ts`, which names three services precisely so it
   * does not have to hold them — and the fix somebody would reach for is to
   * stop naming them, which would delete the types that make the seam safe.
   */
  function valueImports(source: string): string[] {
    const found: string[] = [];
    const code = executable(source);

    for (const match of code.matchAll(IMPORT)) {
      const clause = match[1].trim();
      if (clause.startsWith("type ")) continue;
      const braced = /^\{([\s\S]*)\}$/.exec(clause);
      if (braced) {
        const names = braced[1]
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
        if (names.length === 0) continue;
        if (names.every((name) => name.startsWith("type "))) continue;
      }
      found.push(match[2]);
    }
    for (const match of code.matchAll(SIDE_EFFECT)) found.push(match[1]);
    for (const match of code.matchAll(RE_EXPORT)) found.push(match[1]);
    return found;
  }

  function resolveLocal(specifier: string, fromFile: string): string | null {
    if (!specifier.startsWith(".")) return null;
    const base = normalize(join(dirname(fromFile), specifier));
    for (const candidate of [`${base}.ts`, join(base, "index.ts")])
      if (existsSync(candidate)) return candidate;
    return null;
  }

  function walk(entries: readonly string[]): { files: Set<string>; packages: Set<string> } {
    const files = new Set<string>();
    const packages = new Set<string>();
    const queue = [...entries];

    while (queue.length > 0) {
      const file = queue.shift();
      if (!file || files.has(file) || !existsSync(file)) continue;
      files.add(file);

      for (const specifier of valueImports(readFileSync(file, "utf8"))) {
        if (!specifier.startsWith(".")) {
          packages.add(specifier);
          continue;
        }
        const target = resolveLocal(specifier, file);
        if (target && !files.has(target)) queue.push(target);
      }
    }

    return { files, packages };
  }

  function capabilityFiles(): string[] {
    return execSync(
      `git ls-files --cached --others --exclude-standard -- "${CAPABILITY_DIR}"`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts") && existsSync(file));
  }

  it("has capabilities to check, so a rename cannot silence this", () => {
    // A graph walk from nothing reaches nothing and passes forever.
    expect(capabilityFiles().length).toBeGreaterThan(0);
    expect(CRM_CAPABILITIES.length).toBeGreaterThan(0);
  });

  it("has no path from a capability to the database", () => {
    const { files } = walk(capabilityFiles());
    const schema = [...files].filter((file) => file.startsWith("src/db/"));

    // A capability that needs data no service returns is the ticket's own
    // instruction, not an exception: build the service first. Adding `DRIZZLE`
    // here would make every future capability's boundary a matter of taste.
    expect(schema).toEqual([]);
  });

  it("holds no query builder and no driver", () => {
    const { packages } = walk(capabilityFiles());
    const database = [...packages].filter(
      (name) => name === "postgres" || name.startsWith("drizzle-orm"),
    );

    expect(database).toEqual([]);
  });

  it("names the injection token nowhere in the layer", () => {
    const { files } = walk(capabilityFiles());
    const naming = [...files].filter((file) =>
      executable(readFileSync(file, "utf8")).includes("DRIZZLE"),
    );

    expect(naming).toEqual([]);
  });

  /**
   * The one duplication the boundary costs, pinned so it cannot rot.
   *
   * `dto/crm-mcp.schemas.ts` repeats the activity kinds rather than importing
   * `ACTIVITY_KINDS`, because that const lives in `db/schema` and importing it
   * would put the schema barrel — and through it `drizzle-orm` — into the graph
   * above. A test may import anything, so the coupling lives here: drift fails
   * the build instead of 500ing on the first agent that logs a meeting.
   */
  it("accepts exactly the activity kinds the timeline stores", () => {
    expect([...MCP_ACTIVITY_KINDS].sort()).toEqual([...ACTIVITY_KINDS].sort());
  });

  /**
   * Every capability is gated on a key the platform already knows, which is the
   * first criterion.
   *
   * `authorize()` denies an uncatalogued key outright, so a capability naming a
   * made-up permission would simply never run — a dead tool in `tools/list` that
   * fails for reasons nobody can find. And the same check on the other side:
   * enabling the protocol grants nobody a permission that did not already exist.
   */
  it("gates every capability on a catalogued permission", () => {
    const catalogued = new Set<string>(ALL_PERMISSION_NAMES);
    const unknown = CRM_CAPABILITIES.filter(
      (capability) => !catalogued.has(capability.permission),
    ).map((capability) => `${capability.name} → ${capability.permission}`);

    expect(unknown).toEqual([]);
  });

  it("gives every capability a distinct name and an audit action", () => {
    const names = CRM_CAPABILITIES.map((capability) => capability.name);
    const actions = CRM_CAPABILITIES.map((capability) => capability.auditAction);

    // A duplicate name makes one of the two unreachable through `tools/call`,
    // and a shared audit action makes two different things indistinguishable in
    // the trail that exists to tell them apart.
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(actions).size).toBe(actions.length);
  });
});
