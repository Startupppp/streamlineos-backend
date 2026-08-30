import fs from "node:fs";
import path from "node:path";

/**
 * Phase 3 ticket 09 — a tenant's region does not change under it.
 *
 * Region is a promise about where data rests. Moving a tenant between regions
 * means copying every row it owns into another database and proving nothing was
 * left behind; it is a supported operation, but an offline, deliberate one --
 * never a settings field somebody flips.
 *
 * Today it is immutable **by absence**: nothing updates the column. That is true
 * and it is fragile, because it holds only until somebody adds an organisation
 * settings form with every column on it. A `region` in that form would silently
 * repoint a live tenant at a database its data is not in, and every subsequent
 * query would return an empty result that looks exactly like a deleted record.
 *
 * So this reads the source and keeps the absence honest.
 */

const SRC = path.join(__dirname, "..", "..");

/**
 * Where a deliberate move would live, if one is built.
 *
 * Empty on purpose. Adding a path here is the act of deciding that a move is
 * supported from that place, which is the point at which somebody should think
 * about copying rows and proving the old ones are gone.
 */
const DELIBERATE_MOVE_PATHS: ReadonlySet<string> = new Set<string>();

/**
 * `region` appearing as a key inside a Drizzle `.set({...})`.
 *
 * Both spellings: `region: value` and the shorthand `{ region }`. The first
 * version of this pattern required the colon and therefore missed the shorthand
 * entirely -- which the verification step caught, by injecting a `moveRegion`
 * that the invariant cheerfully passed.
 */
const UPDATES_REGION = /\.set\(\s*\{[^}]*\bregion\s*[:,}]/s;

/**
 * The creation paths, which set a region once and are not updates.
 *
 * `chooseRegionForNewOrg` is the rule now: placement is decided against the
 * cell registry and written as a placement row. `regionForNewOrg` is still the
 * signup-time answer where no placement exists yet, so both count — what this
 * is guarding is that a region arrives through *a* shared rule rather than a
 * literal somebody typed.
 */
const SETS_AT_CREATION = /chooseRegionForNewOrg\(|regionForNewOrg\(\)/;

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith("spec.ts")) found.push(full);
  }
  return found;
}

const sources = walk(SRC).map((file) => ({
  file,
  rel: path.relative(SRC, file).split(path.sep).join("/"),
  text: fs.readFileSync(file, "utf8"),
}));

describe("a tenant's region", () => {
  it("scans a real number of files, so a silent zero is not a pass", () => {
    // A scan that matches nothing reports every invariant as held.
    expect(sources.length).toBeGreaterThan(500);
  });

  it("is set at creation through one rule, not written as a literal", () => {
    // Three creation paths exist. Each calls the same rule, so placement has one
    // answer rather than three that can disagree.
    const setters = sources.filter((source) => SETS_AT_CREATION.test(source.text));

    expect(setters.length).toBeGreaterThanOrEqual(3);
  });

  it("is never updated after creation", () => {
    const updaters = sources
      .filter((source) => !DELIBERATE_MOVE_PATHS.has(source.rel))
      .filter((source) => UPDATES_REGION.test(source.text))
      .map(
        (source) =>
          `${source.rel} — updates organizations.region. Moving a tenant between ` +
          `regions means copying every row it owns and proving nothing was left ` +
          `behind; it is not a column update. If this is a deliberate move ` +
          `operation, add the path to DELIBERATE_MOVE_PATHS.`,
      );

    expect(updaters).toEqual([]);
  });

  it("keeps the deliberate-move list empty until a real move exists", () => {
    // Adding a path here is the act of deciding a move is supported from there,
    // which is when somebody should be thinking about copying rows.
    expect(DELIBERATE_MOVE_PATHS.size).toBe(0);
  });
});
