import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * D5 — a ratchet, not a style rule.
 *
 * `inv_valuation_layers.unit_cost` is `numeric(18,4)`, and `parseFloat` on it is
 * lossy in both directions: it drops precision going in and invents digits
 * coming out. Sixteen call sites across these two trees turned an exact decimal
 * into an IEEE double, multiplied it by another one, and then wrote
 * `Math.round(v * 10000) / 10000` to hide the fraction they had just created.
 * The visible symptom was a page total that disagreed with the same query
 * grouped differently; the invisible one is that an organisation's stock value
 * was quoted from arithmetic nobody could reproduce.
 *
 * Typecheck cannot see this — `parseFloat` returns `number` and everything
 * downstream is a `number`, so the code is well typed and wrong. Grepping for
 * the shape is the only cheap thing that catches the seventeenth.
 *
 * `Number(row.count)` on an integer row count is fine and stays fine; the second
 * check only fires on an identifier that reads as a quantity or a money value.
 */
const TREES = ["valuation", "reports"] as const;

const QUANTITY_OR_MONEY =
  /\b(?:parseFloat|Number)\s*\(\s*[A-Za-z0-9_.?[\]"' ]*(?:qty|quantity|cost|value|onhand|on_hand|price|total|average|remaining)/i;

/**
 * Comments are prose, not code.
 *
 * Both trees now carry comments explaining the arithmetic they moved into
 * Postgres, and those comments name `parseFloat` because that is what was
 * removed. A guard that matched the raw file text flagged its own documentation
 * and would push the next author to stop explaining the defect they fixed — so
 * it reads what the compiler reads. String literals cannot smuggle a call past
 * this: a `//` inside one is a URL, and a URL has no `parseFloat(` in it.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : sources(path);
    if (!path.endsWith(".ts")) return [];
    return path.includes("spec.ts") ? [] : [path];
  });
}

function inventoryTrees(): string[] {
  const root = join(__dirname, "..", "..");
  return TREES.flatMap((tree) => sources(join(root, tree)));
}

function relative(path: string): string {
  const root = join(__dirname, "..", "..");
  return path.slice(root.length + 1);
}

describe("no inventory quantity or cost is parsed into a float", () => {
  it("finds no parseFloat under valuation/ or reports/", () => {
    const offenders = inventoryTrees().filter((path) =>
      /\bparseFloat\s*\(/.test(code(path)),
    );

    expect(offenders.map(relative)).toEqual([]);
  });

  it("finds no Number() applied to a quantity, a cost or a value", () => {
    const offenders = inventoryTrees().filter((path) =>
      QUANTITY_OR_MONEY.test(code(path)),
    );

    expect(offenders.map(relative)).toEqual([]);
  });

  it("still recognises the shape it is guarding against", () => {
    expect(QUANTITY_OR_MONEY.test("const onHand = parseFloat(r.onHand);")).toBe(true);
    expect(QUANTITY_OR_MONEY.test("value = onHand * parseFloat(r.standardCost ?? \"0\");")).toBe(true);
    expect(QUANTITY_OR_MONEY.test("averageCost: parseFloat(r.avgCost),")).toBe(true);
    expect(QUANTITY_OR_MONEY.test("const total = Number(row.count);")).toBe(false);
    expect(QUANTITY_OR_MONEY.test("Number(shipping.median_transit_hours)")).toBe(false);
  });
});
