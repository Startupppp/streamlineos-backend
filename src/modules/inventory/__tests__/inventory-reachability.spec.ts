import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Committed is not reachable.
 *
 * This programme has now had the same failure three times, and it is the one a
 * checklist cannot catch: a unit is built, it typechecks, its tests pass, it is
 * committed and ticked — and nothing calls it. E5's compliance service was the
 * clearest case. It had a module, the module was registered in
 * `inventory.module.ts`, and `IndiaComplianceService` had no caller anywhere
 * outside its own directory. With the flag on, nothing happened either way. An
 * earlier adversarial review of this module found nine features in that state.
 *
 * The check that catches it is embarrassingly simple — grep for a caller outside
 * the unit's own folder — which is exactly why it is worth automating. A check
 * you have to remember to run is a check that stops running.
 *
 * **What counts as reachable.** A sub-module is reachable if it exposes an HTTP
 * surface (a controller), or if something outside its own directory imports it.
 * A service that only its own module uses is either a helper — fine — or a
 * feature nobody can get to, and this cannot tell those apart. So the unit of
 * judgement is the *directory*: a whole folder that neither serves a route nor
 * is imported by anyone is a feature with no way in.
 *
 * **What it deliberately does not do.** It does not check that a route is
 * *permitted*, or that a service does anything useful. Reachability is a floor.
 */

const INVENTORY_DIR = join(__dirname, "..");
const BACKEND_SRC = join(__dirname, "..", "..", "..");

/** Sub-modules whose only job is to be depended on, with the reason. */
const LIBRARY_MODULES: Record<string, string> = {
  __tests__: "the specs themselves, which nothing imports by design",
  "stock-engine":
    "the engine every other unit writes stock through; reachable by definition, and its own specs cover it",
  observability:
    "counters incremented from the engine and a controller of its own; the counter registry is a module-level singleton by design",
};

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, acc);
    } else if (full.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

const ALL_SOURCES = walk(BACKEND_SRC).filter((p) => !p.includes(".spec.ts"));

/** Every `@Injectable()` class a directory exports, which is what a caller would name. */
function exportedServices(dir: string): string[] {
  const names: string[] = [];
  for (const file of walk(dir)) {
    if (file.includes(".spec.ts")) continue;
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/export class (\w+)/g)) {
      const name = m[1];
      if (name && !name.endsWith("Module") && !name.endsWith("Controller")) names.push(name);
    }
  }
  return [...new Set(names)];
}

function hasController(dir: string): boolean {
  return walk(dir).some((f) => f.endsWith(".controller.ts"));
}

/** Whether anything outside `dir` names one of these symbols. */
function calledFromOutside(dir: string, symbols: string[]): string | null {
  if (symbols.length === 0) return null;
  for (const file of ALL_SOURCES) {
    if (file.startsWith(dir + "/")) continue;
    const source = readFileSync(file, "utf8");
    for (const symbol of symbols) {
      // A word-boundary match on the class name. Loose on purpose: a false
      // *pass* here is far less costly than a false failure that trains people
      // to add exemptions.
      if (new RegExp(`\\b${symbol}\\b`).test(source)) return file;
    }
  }
  return null;
}

describe("inventory features are reachable, not merely committed", () => {
  const subModules = readdirSync(INVENTORY_DIR).filter((entry) =>
    statSync(join(INVENTORY_DIR, entry)).isDirectory(),
  );

  it("finds the sub-modules at all, so a broken walk cannot pass silently", () => {
    expect(subModules.length).toBeGreaterThan(20);
  });

  it("gives every sub-module either an HTTP surface or a caller outside itself", () => {
    const unreachable: string[] = [];

    for (const name of subModules) {
      if (name in LIBRARY_MODULES) continue;
      const dir = join(INVENTORY_DIR, name);
      if (hasController(dir)) continue;
      const caller = calledFromOutside(dir, exportedServices(dir));
      if (caller === null) {
        unreachable.push(
          `${name} — no controller, and nothing outside src/modules/inventory/${name}/ names any class it exports`,
        );
      }
    }

    expect(unreachable).toEqual([]);
  });

  it("names every library exemption, so the list cannot quietly absorb a real gap", () => {
    // An exemption with no reason beside it is how this check stops checking.
    for (const [name, reason] of Object.entries(LIBRARY_MODULES)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(subModules).toContain(name);
    }
  });
});
