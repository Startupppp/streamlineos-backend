import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ALL_PERMISSION_NAMES } from "../permissions";

/**
 * Every key a route is gated on has to exist in the catalogue.
 *
 * The catalogue is not what the guard reads — `PermissionGuard` compares the
 * decorator's string against the set resolved from `role_permission_grants`, so
 * a key missing from the catalogue still gates the route perfectly for anyone
 * a migration granted it to. That is what makes this one silent.
 *
 * What the catalogue decides is everyone who comes *later*.
 * `seedSystemRolesForOrg` builds a new organisation's grants from the module's
 * namespace in the catalogue, so a key that is not there is never granted to an
 * organisation created after it shipped. The endpoint then works for every
 * tenant that existed when the backfill ran and 403s for every tenant since,
 * which is the same divergence-by-signup-date that migration 0226 exists to
 * prevent, arriving from the opposite direction.
 *
 * `party:divergence:view` did exactly this: gated on `party.controller.ts`,
 * granted to 18 roles by migration 0244, and absent from
 * `permissions/party.ts`. Nothing failed. The route answered for every
 * organisation on the database and would have 403'd for the next one created.
 *
 * This is the third shape of one bug the phase keeps producing — a grant
 * targeting a slug nobody mints, a repair that missed two keys, and now a gate
 * with no catalogue entry. `backfill-slugs-exist.spec.ts` covers the first two
 * by reading migration SQL. This covers the third by reading the decorators.
 */
describe("every gated permission key is in the catalogue", () => {
  const KEY = /@RequirePermission\(\s*"([^"]+)"/g;
  /** A decorator taking a constant rather than a literal; counted, not guessed at. */
  const NON_LITERAL = /@RequirePermission\(\s*(?!")/g;
  /** `@RequirePermission(SOME_CONSTANT)` — the identifier, for resolution below. */
  const NAMED = /@RequirePermission\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;

  const sourceFiles = (): string[] =>
    execSync('git ls-files --cached --others --exclude-standard -- "src/**/*.ts"', {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
      .split("\n")
      .filter((path) => path.endsWith(".ts") && !path.endsWith(".spec.ts"));

  interface Gate {
    file: string;
    key: string;
  }

  const scan = (): { gates: Gate[]; viaConstant: number } => {
    const gates: Gate[] = [];
    let viaConstant = 0;

    for (const file of sourceFiles()) {
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!source.includes("@RequirePermission")) continue;

      for (const match of source.matchAll(KEY)) gates.push({ file, key: match[1] });

      /*
        A decorator naming a constant is BETTER code than one naming a literal,
        and the reason is the bug two files over: `call-analysis-backfill.spec.ts`
        requires the constant form precisely so a decorator and its backfill
        migration cannot drift by a typo nobody notices until a tenant reports a
        403. Asking those routes to inline their strings so this regex can read
        them would make the code worse to keep a test simple.

        So the constant is followed instead. Only the ones that cannot be
        resolved — a computed key, a re-export chain, a constant built from
        parts — remain uncovered, and those are what `viaConstant` counts.
      */
      let unresolved = [...source.matchAll(NON_LITERAL)].length;
      for (const match of source.matchAll(NAMED)) {
        const key = resolveConstant(file, source, match[1]!);
        if (key === null) continue;
        gates.push({ file, key });
        unresolved -= 1;
      }
      viaConstant += Math.max(0, unresolved);
    }

    return { gates, viaConstant };
  };

  /**
   * The literal behind `@RequirePermission(SOME_CONSTANT)`, or null.
   *
   * Deliberately shallow: one hop, to a relative import, to an
   * `export const NAME = "literal"` in that file. Anything deeper is a chain
   * this test should not be simulating a compiler for, and is honestly reported
   * as uncovered rather than guessed at.
   */
  const resolveConstant = (file: string, source: string, identifier: string): string | null => {
    const importOf = new RegExp(
      `import\\s*\\{[^}]*\\b${identifier}\\b[^}]*\\}\\s*from\\s*"(\\.[^"]+)"`,
    );
    const declaredHere = new RegExp(`export\\s+const\\s+${identifier}\\s*=\\s*"([^"]+)"`);

    const here = declaredHere.exec(source);
    if (here) return here[1]!;

    const imported = importOf.exec(source);
    if (!imported) return null;

    const base = resolve(dirname(file), imported[1]!);
    for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
      if (!existsSync(candidate)) continue;
      const target = declaredHere.exec(readFileSync(candidate, "utf8"));
      if (target) return target[1]!;
    }
    return null;
  };

  it("finds no gate naming a key the catalogue does not have", () => {
    const catalogued = new Set<string>(ALL_PERMISSION_NAMES);
    const { gates } = scan();

    const missing = gates
      .filter((gate) => !catalogued.has(gate.key))
      .map((gate) => `${gate.file} → ${gate.key}`)
      .sort();

    // The fix is a catalogue entry in the module's file under `permissions/`,
    // plus the same key in the frontend catalogue, plus a backfill migration
    // targeting `${MODULE}_MODULE_OWNER|ADMIN|MEMBER` for the organisations
    // that already exist. All three, or it reaches somebody and not others.
    expect([...new Set(missing)]).toEqual([]);
  });

  /**
   * Says out loud what the scan above cannot see, rather than leaving the
   * coverage implied. A handful of decorators take a shared constant, which a
   * regex cannot resolve; if that number grows the scan is quietly covering
   * less than it looks like it is, and this fails and says so.
   */
  it("reads almost every gate, and names how many it cannot", () => {
    const { gates, viaConstant } = scan();

    expect(gates.length).toBeGreaterThan(2500);
    expect(viaConstant).toBeLessThanOrEqual(25);
  });

  it("actually follows a constant to its literal, rather than passing vacuously", () => {
    /*
      Without this, the resolution above could quietly resolve nothing — every
      constant would fall through to `viaConstant`, the cap would still hold at
      today's count, and the first person to add a gated route behind a constant
      would find the coverage claim was never true.
    */
    const { gates } = scan();
    const resolved = gates.filter((gate) => gate.key.startsWith("crm:call-analysis:"));
    expect(resolved.map((gate) => gate.key).sort()).toEqual([
      "crm:call-analysis:view-own",
      "crm:call-analysis:view-team",
    ]);
  });
});
