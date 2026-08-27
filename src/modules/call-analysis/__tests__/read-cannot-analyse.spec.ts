import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import "reflect-metadata";
import { CallAnalysisReadModule } from "../read/call-analysis-read.module";
import { CallAnalysisReadService } from "../read/call-analysis-read.service";
import { CallAnalysisAnalyserModule } from "../analyse/call-analysis-analyser.module";
import { CallAnalysisWriterService } from "../analyse/call-analysis-writer.service";
import type { Db } from "../../../db/drizzle.types";

/**
 * Ticket 01's third criterion: re-analysis on view is impossible by construction.
 *
 * Not discouraged, not guarded by a flag, not documented as a rule. The read
 * surface has no path to the analyser, in the same sense that a report cannot
 * opt out of tenancy — there is nowhere to say it.
 *
 * Three independent claims, because one alone would be circumventable:
 *
 *   1. No file in the read half imports anything from the analyse half. Somebody
 *      wiring a "re-analyse" button has to write that import first, and this
 *      test refuses it before the button does anything.
 *   2. Nest's module graph from `CallAnalysisReadModule` does not reach the
 *      analyser module or the AI gateway. So even a file that got the import
 *      past (1) could not inject the writer: the provider is not in the read
 *      module's injector, and the failure would be at boot rather than a
 *      silently expensive request.
 *   3. Reading a call that has never been analysed writes nothing and returns
 *      nothing. The consequence, in case both structural claims were somehow
 *      satisfied by a service that wrote anyway.
 *
 * The criterion is worth this much machinery because of what it is protecting.
 * Analysis is the largest per-record model cost in the product, so the failure
 * mode of "analyse on view" is not a slow page — it is a bill proportional to
 * how often a popular call is opened, discovered a month later.
 */

const MODULE_DIR = resolve(__dirname, "..");
const READ_DIR = join(MODULE_DIR, "read");
const ANALYSE_DIR = join(MODULE_DIR, "analyse");

/** A module as this test needs it: an identity to compare and a name to report. */
interface ModuleClass {
  readonly name: string;
}

/**
 * One entry of a `@Module({ imports })` list as a class, or null.
 *
 * A dynamic module and a `forwardRef` wrapper are objects rather than classes,
 * and both still name the class they stand for — so following `.module` is what
 * keeps the walk honest. Skipping them would let somebody hide the analyser
 * behind `AnalyserModule.forRoot()` and leave this test green.
 */
function asModuleClass(value: unknown): ModuleClass | null {
  if (typeof value === "function") return value as unknown as ModuleClass;
  if (value !== null && typeof value === "object" && "module" in value) {
    const inner = (value as { module: unknown }).module;
    if (typeof inner === "function") return inner as unknown as ModuleClass;
  }
  return null;
}

function typescriptFilesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory()
      ? typescriptFilesIn(full)
      : entry.name.endsWith(".ts")
        ? [full]
        : [];
  });
}

/** Every `from "…"` specifier in a file, import or re-export alike. */
function specifiersIn(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
}

/** A relative specifier as a real file on disk, or null if it leaves TypeScript. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);

  for (const candidate of [`${base}.ts`, join(base, "index.ts")])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;

  return null;
}

describe("the read half cannot reach the analyser", () => {
  it("has a read half and an analyse half to compare", () => {
    // A test that walks two directories reports nothing at all if one is empty.
    expect(typescriptFilesIn(READ_DIR).length).toBeGreaterThan(0);
    expect(typescriptFilesIn(ANALYSE_DIR).length).toBeGreaterThan(0);
  });

  it("imports nothing from the analyse half, at any depth inside this module", () => {
    /**
     * Transitive within the module: a read file importing a domain file that
     * imports the writer would be caught here, which is the shape the rule would
     * most plausibly be broken in — nobody adds `import { Writer }` to a
     * controller, they add it to a helper.
     */
    const seen = new Set<string>();
    const queue = typescriptFilesIn(READ_DIR);
    const offenders: string[] = [];

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);

      for (const specifier of specifiersIn(file)) {
        const target = resolveRelative(file, specifier);
        if (!target) {
          // Leaves the module. Only two destinations would matter.
          if (/modules\/ai\/|\/ai\/core\//.test(specifier))
            offenders.push(`${relative(MODULE_DIR, file)} -> ${specifier}`);
          continue;
        }

        if (target.startsWith(`${ANALYSE_DIR}/`))
          offenders.push(`${relative(MODULE_DIR, file)} -> ${relative(MODULE_DIR, target)}`);
        else if (target.startsWith(`${MODULE_DIR}/`)) queue.push(target);
      }
    }

    expect(offenders).toEqual([]);

    /**
     * And the walk actually walked. Every claim above is vacuously true if the
     * specifier regex stops matching — a formatter switching the repository to
     * single quotes would do it — so the closure has to be seen reaching the
     * domain files the read half imports.
     */
    expect([...seen].map((file) => relative(MODULE_DIR, file))).toEqual(
      expect.arrayContaining(["coaching.ts", "visibility.ts", "permissions.ts"]),
    );
  });

  it("does not reach the analyser module or a model client through Nest's graph", () => {
    /**
     * The injectability claim. Nest resolves a provider only through the module
     * graph, so a controller in the read module cannot inject the writer however
     * it is declared — the injection fails at boot.
     */
    const reachable = new Set<ModuleClass>();
    const queue: ModuleClass[] = [CallAnalysisReadModule];

    while (queue.length > 0) {
      const current = queue.pop()!;
      if (reachable.has(current)) continue;
      reachable.add(current);

      const imports: unknown = Reflect.getMetadata("imports", current);
      if (!Array.isArray(imports)) continue;

      for (const imported of imports as unknown[]) {
        const target = asModuleClass(imported);
        if (target) queue.push(target);
      }
    }

    const names = [...reachable].map((entry) => entry.name);
    expect(names).not.toContain(CallAnalysisAnalyserModule.name);
    expect(names).not.toContain("AiGatewayModule");

    const providers = [...reachable].flatMap((entry) => {
      const declared: unknown = Reflect.getMetadata("providers", entry);
      return Array.isArray(declared) ? declared : [];
    });

    expect(providers).not.toContain(CallAnalysisWriterService);
  });

  it("returns nothing and writes nothing for a call that has never been analysed", () => {
    /**
     * The consequence. The fake refuses every write outright, so a read service
     * that quietly created a row — or a placeholder, or a job — fails here rather
     * than in production three weeks later.
     */
    const refuseWrites = (verb: string) => (): never => {
      throw new Error(`the read surface issued a ${verb}`);
    };

    const emptyQuery = {
      from: () => emptyQuery,
      where: () => emptyQuery,
      orderBy: () => Promise.resolve([]),
    };

    const fakeDb = {
      select: () => emptyQuery,
      insert: refuseWrites("insert"),
      update: refuseWrites("update"),
      delete: refuseWrites("delete"),
      execute: refuseWrites("execute"),
      transaction: refuseWrites("transaction"),
    } as unknown as Db;

    const service = new CallAnalysisReadService(fakeDb);

    return expect(service.forRep("org-1", "rep-1")).resolves.toMatchObject({
      calls: [],
      trend: [],
      prompts: [],
    });
  });
});
