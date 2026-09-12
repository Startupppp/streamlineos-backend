/**
 * A1 — availability has one definition, and this is the ratchet that keeps it
 * that way.
 *
 * A1 collapsed eight hand-written copies of `on_hand − committed − blocked_qty
 * − quality_hold_qty − outgoing_qty` into `availableQtySql` and its TypeScript
 * twin `availableQty`. Three of them grew back anyway, each rendering a number
 * labelled "available" to a human and each short of terms:
 *
 *   - the stock-summary report (server side of a two-term frontend copy),
 *   - the AI stockout-risk insight (three terms, on floats),
 *   - the Ask-OS copilot's product lookup (two terms).
 *
 * A copy is not found by reading the diff that adds it — it looks correct in
 * isolation, and it is wrong only relative to a definition somewhere else. So
 * the check is mechanical: no file outside the two canonical ones may subtract
 * one stock-level bucket from another. Add a term to the formula and every call
 * site gets it; write the subtraction by hand and this fails.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { availableQtySql, availableQtySumSql } from "../available-sql";
import { AVAILABLE_QTY_TERMS } from "../decimal";

const SRC_ROOT = join(__dirname, "..", "..", "..", "..");

/** The two files that are allowed to say what availability is. */
const CANONICAL = [
  join("modules", "inventory", "stock-engine", "available-sql.ts"),
  join("modules", "inventory", "stock-engine", "decimal.ts"),
];

/**
 * Copies that exist today, are defects, and belong to another lane.
 *
 * `channels.service.ts` publishes an "available" quantity to every sales
 * channel from a four-term float sum that drops `outgoing_qty` and cannot apply
 * the non-sellable-location gate at all, because it has already summed the rows
 * across locations. It is listed so this ratchet can be switched on now rather
 * than after somebody else's fix; it is not blessed. Do not add to this list —
 * a new entry means a ninth copy shipped.
 */
// Empty, and the second case below fails if a fixed file is left here — a
// ratchet that never tightens is a to-do list. `channels.service.ts` published
// its own four-term copy, in floats, summed across locations *before*
// subtracting, so the non-sellable gate could not be applied at all and stock on
// a lorry was offered to marketplaces. Both of its paths now use the shared
// expression.
const UNFIXED_SURVIVORS: string[] = [];

/**
 * A bucket subtracted from another bucket, in TypeScript or in SQL text.
 *
 * Matched against source with comments removed and whitespace flattened, so a
 * copy spread over five lines reads the same as one written on a single line —
 * which is how the picking-wave and quality-hold copies used to hide.
 */
const HAND_WRITTEN_AVAILABILITY = [
  /on_?hand[^-]{0,30}-[^-]{0,40}committed/i,
  /on_?hand[^-]{0,30}-[^-]{0,40}reserved/i,
  /-[^-]{0,20}committed[^-]{0,25}-[^-]{0,25}blocked/i,
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      found.push(path);
    }
  }
  return found;
}

function offenders(): string[] {
  const hits: string[] = [];
  for (const path of sourceFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, path);
    if (CANONICAL.includes(rel)) continue;
    // Specs assert against a formula on purpose; the ratchet is about the
    // product code that answers a request.
    if (/\.(spec|e2e-spec)\.ts$/.test(rel)) continue;
    if (rel.split(sep).includes("__tests__")) continue;

    const flattened = stripComments(readFileSync(path, "utf8")).replace(/\s+/g, " ");
    if (HAND_WRITTEN_AVAILABILITY.some((pattern) => pattern.test(flattened))) hits.push(rel);
  }
  return hits.sort();
}

/** The three copies this change removed, exactly as they were written. */
const REMOVED_COPIES = [
  "available: s.onHand - s.committed,",
  "const available = parseFloat(r.onHand) - parseFloat(r.committed) - parseFloat(r.outgoing);",
  "availableQty: onHandQty - reservedQty,",
];

describe("A1 — one definition of availability", () => {
  it("recognises the copies it was written to catch", () => {
    // Without this the ratchet could be vacuous: a detector that matches
    // nothing passes for exactly as long as it is useless.
    for (const copy of REMOVED_COPIES) {
      expect(HAND_WRITTEN_AVAILABILITY.some((pattern) => pattern.test(copy))).toBe(true);
    }
  });

  it("subtracts every term, and only in the canonical SQL", () => {
    const rendered = new PgDialect().sqlToQuery(availableQtySql("sl")).sql;
    for (const term of AVAILABLE_QTY_TERMS) expect(rendered).toContain(`sl.${term}`);
    expect(rendered).toContain("sl.on_hand");
    // A2's gate: stock standing at a non-sellable location is not available,
    // whatever the five terms say.
    expect(rendered).toContain("is_sellable IS FALSE");
    expect(new PgDialect().sqlToQuery(availableQtySumSql("sl")).sql).toContain("SUM");
  });

  it("has no hand-written copy left in product code", () => {
    expect(offenders()).toEqual(UNFIXED_SURVIVORS.slice().sort());
  });

  it("keeps the survivor list honest — a fixed file must be removed from it", () => {
    // Guards the other direction: an entry that no longer matches means the
    // copy was fixed and the exemption is stale, which quietly re-opens the
    // door for the next one.
    const remaining = offenders();
    for (const known of UNFIXED_SURVIVORS) expect(remaining).toContain(known);
  });
});
