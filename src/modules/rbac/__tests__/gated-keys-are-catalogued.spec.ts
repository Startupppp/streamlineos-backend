import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
      viaConstant += [...source.matchAll(NON_LITERAL)].length;
    }

    return { gates, viaConstant };
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
  it("reads almost every gate directly, and names how many it cannot", () => {
    const { gates, viaConstant } = scan();

    expect(gates.length).toBeGreaterThan(2500);
    expect(viaConstant).toBeLessThanOrEqual(25);
  });
});
