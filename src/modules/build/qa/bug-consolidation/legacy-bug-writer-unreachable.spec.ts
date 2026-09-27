import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import "reflect-metadata";
import { BuildQaModule } from "../build-qa.module";

const SRC_ROOT = resolve(__dirname, "..", "..", "..", "..");
const SCHEMA_DIR = join(SRC_ROOT, "db", "schema");

const SCANNED_FILE_FLOOR = 1200;

const BUGS_TABLE_IMPORTERS_ALLOWLIST: readonly string[] = [];

const SCHEMA_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']*db\/schema(?:\/[^"']*)?)["']/g;

const BUGS_TABLE_OPERAND = /\.(?:insert|update|delete|from|select)\(\s*(?:[A-Za-z_$][\w$]*\.)?bugs\b/;

function isSpec(file: string): boolean {
  return /\.(?:spec|e2e-spec)\.ts$/.test(file);
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (full === SCHEMA_DIR) continue;
      walkTs(full, out);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !isSpec(entry)) out.push(full);
  }
  return out;
}

function schemaBindings(source: string): Set<string> {
  const names = new Set<string>();
  SCHEMA_IMPORT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCHEMA_IMPORT.exec(source)) !== null) {
    for (const raw of match[1]!.split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function bodyOf(fn: unknown): string {
  return Function.prototype.toString.call(fn);
}

function selfCallTargets(body: string): Set<string> {
  const targets = new Set<string>();
  for (const m of body.matchAll(/this\.[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\s*\(/g))
    targets.add(m[1]!);
  for (const m of body.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)) targets.add(m[1]!);
  return targets;
}

type Ctor = { new (...args: never[]): object; name: string; prototype: Record<string, unknown> };

function moduleMembers(key: string): Ctor[] {
  return (Reflect.getMetadata(key, BuildQaModule) as Ctor[] | undefined) ?? [];
}

function routeHandlerNames(controller: Ctor): string[] {
  const proto = controller.prototype;
  return Object.getOwnPropertyNames(proto).filter((name) => {
    if (name === "constructor") return false;
    const member = (proto as Record<string, unknown>)[name];
    if (typeof member !== "function") return false;
    return Reflect.getMetadata("path", member) !== undefined;
  });
}

function reachableProviderMethods(): Map<string, string> {
  const providers = moduleMembers("providers");
  const bodies = new Map<string, string>();
  const queue: string[] = [];

  for (const controller of moduleMembers("controllers")) {
    for (const handler of routeHandlerNames(controller)) {
      const body = bodyOf((controller.prototype as Record<string, unknown>)[handler]);
      bodies.set(`${controller.name}.${handler}`, body);
      for (const target of selfCallTargets(body)) queue.push(target);
    }
  }

  const seen = new Set<string>();
  while (queue.length > 0) {
    const method = queue.pop()!;
    if (seen.has(method)) continue;
    seen.add(method);
    for (const provider of providers) {
      const member = (provider.prototype as Record<string, unknown>)[method];
      if (typeof member !== "function") continue;
      const body = bodyOf(member);
      bodies.set(`${provider.name}.${method}`, body);
      for (const target of selfCallTargets(body)) queue.push(target);
    }
  }
  return bodies;
}

describe("no route the QA module registers can reach a write of the legacy build.bugs table", () => {
  const reachable = reachableProviderMethods();

  it("enumerates the QA module's registered controllers, providers and route handlers, so the walk below is not vacuous", () => {
    expect(moduleMembers("controllers").length).toBeGreaterThanOrEqual(4);
    expect(moduleMembers("providers").length).toBeGreaterThanOrEqual(3);
    const handlers = moduleMembers("controllers").flatMap((c) =>
      routeHandlerNames(c).map((h) => `${c.name}.${h}`),
    );
    expect(handlers.length).toBeGreaterThanOrEqual(15);
    expect(handlers).toContain("TestRunsController.createBugFromResult");
  });

  it("resolves the bug-from-result route through to the consolidated work-item writer, proving the call graph is followed and not merely named", () => {
    expect([...reachable.keys()]).toContain("TestRunsService.createBugFromResultConsolidated");
    expect(reachable.get("TestRunsService.createBugFromResultConsolidated")).toMatch(
      /\.insert\(\s*(?:[A-Za-z_$][\w$]*\.)?tickets\b/,
    );
  });

  it("detects a bugs-table operand in a method body, so a zero count below means absence and not a broken matcher", () => {
    expect(BUGS_TABLE_OPERAND.test("await tx.insert(schema_1.bugs).values({})")).toBe(true);
    expect(BUGS_TABLE_OPERAND.test("await tx.insert(bugs).values({})")).toBe(true);
    expect(BUGS_TABLE_OPERAND.test("await tx.insert(schema_1.tickets).values({})")).toBe(false);
  });

  it("finds no method reachable from a registered route that inserts, updates, deletes or reads build.bugs", () => {
    const writers = [...reachable.entries()]
      .filter(([, body]) => BUGS_TABLE_OPERAND.test(body))
      .map(([name]) => name);
    expect(writers).toEqual([]);
  });
});

describe("the bugs Drizzle table is imported nowhere outside src/db/schema", () => {
  const files = walkTs(SRC_ROOT);

  it("walks the whole of src, so an empty violation set below is a real absence", () => {
    expect(files.length).toBeGreaterThanOrEqual(SCANNED_FILE_FLOOR);
    const relatives = files.map((f) => relative(SRC_ROOT, f).replace(/\\/g, "/"));
    expect(relatives).toContain("modules/build/qa/test-runs.service.ts");
    expect(relatives).toContain("modules/build/qa/bugs.service.ts");
    expect(relatives.some((f) => f.startsWith("db/schema/"))).toBe(false);
    expect(relatives.some((f) => f.endsWith(".spec.ts"))).toBe(false);
  });

  it("reads real schema bindings out of a real file, so the matcher is proven against repository content and not only a fixture", () => {
    const bindings = schemaBindings(
      readFileSync(join(SRC_ROOT, "modules", "build", "qa", "test-runs.service.ts"), "utf8"),
    );
    expect([...bindings]).toEqual(expect.arrayContaining(["tickets", "testRuns", "workItemQaDetails"]));
    expect(schemaBindings('import { bugs } from "../../../db/schema";').has("bugs")).toBe(true);
    expect(schemaBindings('import { bugs as legacy } from "../../../db/schema";').has("bugs")).toBe(true);
  });

  it("names every non-spec source file outside src/db/schema that still imports the bugs table", () => {
    const importers = files
      .filter((file) => schemaBindings(readFileSync(file, "utf8")).has("bugs"))
      .map((file) => relative(SRC_ROOT, file).replace(/\\/g, "/"))
      .sort();
    expect(importers).toEqual([...BUGS_TABLE_IMPORTERS_ALLOWLIST].sort());
  });

  it("keeps the allowlist free of stale entries, so a removed file cannot leave the gate permanently satisfied", () => {
    const relatives = new Set(files.map((f) => relative(SRC_ROOT, f).replace(/\\/g, "/")));
    for (const entry of BUGS_TABLE_IMPORTERS_ALLOWLIST) expect(relatives.has(entry)).toBe(true);
  });
});
