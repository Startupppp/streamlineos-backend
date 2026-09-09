/**
 * check-stock-writers.mjs — INV-01.
 *
 * The census, as a gate: every write to `inv_stock_levels` and
 * `inv_stock_transactions` is either `MovementApplyService` or an entry on the
 * list below with a reason.
 *
 * The invariant this defends is the pack's first one — one mutation kernel. It
 * is not defensible by review, because a second writer does not look wrong at
 * the call site: it looks like a small correct UPDATE. It only looks wrong from
 * here, where all of them are visible at once. The two bugs this module has
 * already had — a release predicate that decremented every lot at a location,
 * and a recompute that wrote an owned figure onto a consigned row — were both
 * committed by people who had read the surrounding code.
 *
 * Usage:
 *   node src/scripts/check-stock-writers.mjs
 *   node src/scripts/check-stock-writers.mjs --json
 *   node src/scripts/check-stock-writers.mjs --self-test
 *
 * Exit codes:
 *   0 — every writer is the kernel or an acknowledged exception
 *   1 — an unacknowledged writer, or an exception that no longer writes
 *   2 — vacuity guard fired (the scan did not find the kernel's own writes)
 *   3 — self-test failure
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(__dirname, "../..");
const SCAN_ROOTS = [join(BACKEND_ROOT, "src", "modules", "inventory")];

/** The two tables that are the ledger and its projection. */
const TABLES = {
  levels: { drizzle: "invStockLevels", sql: "inv_stock_levels" },
  ledger: { drizzle: "invStockTransactions", sql: "inv_stock_transactions" },
};

/**
 * A write, in either of the two spellings this codebase uses.
 *
 * Raw SQL is not a lesser case to be handled for completeness — three of the
 * five writers found by the first census were raw SQL, because the things that
 * need a `GREATEST`, a `NOT DISTINCT FROM` or a CTE cannot be said in the query
 * builder. A gate that only understood drizzle would have reported one writer
 * and passed.
 */
function writesIn(source, table) {
  const hits = [];
  const lines = source.split("\n");

  const drizzle = new RegExp(`\\.(insert|update|delete)\\(\\s*${table.drizzle}\\s*[,)]`);
  const raw = new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+"?${table.sql}"?\\b`, "i");

  lines.forEach((line, index) => {
    if (drizzle.test(line) || raw.test(line)) hits.push({ line: index + 1, text: line.trim() });
  });

  return hits;
}

/**
 * Who may write, and why.
 *
 * Every entry is a claim someone has to defend at review time, which is the
 * point — the list is short and adding to it is meant to be uncomfortable. The
 * `buckets` field says which columns the exception is for; it is documentation
 * rather than something the scanner can check, and it is here so that a widened
 * exception is visible as a diff rather than as a silent change of meaning.
 */
/**
 * The six columns `uniq_inv_stock_levels_natural_key` is built from.
 *
 * A writer that names a row by fewer than all of them writes to more rows than
 * it means to, and the extra ones are somebody else's stock. This module has
 * had that bug twice — `lot_id` missing from a release predicate, then
 * `ownership` missing from the same one — and both times the arithmetic
 * clamped, so there was no negative number and no error, just stock quietly
 * becoming available again.
 *
 * Checked only for writers, not for readers. Most of the module aggregates
 * across grains on purpose: a stock report, a forecast and a reorder proposal
 * are all supposed to sum a variant across lots and pallets, so requiring the
 * full key of every reader would flag thirty correct files and teach everyone
 * to ignore the gate.
 */
const NATURAL_KEY = [
  "product_variant_id|productVariantId",
  "location_id|locationId",
  "lot_id|lotId",
  "serial_id|serialId",
  "handling_unit_id|handlingUnitId",
  "ownership",
];

const ACKNOWLEDGED = [
  {
    file: "stock-engine/movement-apply.service.ts",
    tables: ["levels", "ledger"],
    buckets: "everything",
    grain: "full",
    reason: "The kernel. This is the one writer the invariant exists to protect.",
  },
  {
    file: "stock-engine/stock-level-locks.ts",
    tables: ["levels"],
    buckets: "none — inserts an all-zero row",
    grain: "full",
    reason:
      "Materialises a missing grain so it can be locked, with ON CONFLICT DO NOTHING and every bucket '0'. It moves no quantity; without it the kernel cannot take a row lock on a grain that has never held stock.",
  },
  {
    file: "stock-engine/reservation.service.ts",
    tables: ["levels"],
    buckets: "committed",
    grain: "full",
    reason:
      "INV-40, OPEN. Reservations increment and decrement `committed` directly and write no ledger row. A reservation is a promise rather than a movement, so it is not obviously the kernel's work — but it is the one exception here that the pack has already decided should be removed.",
  },
  {
    file: "reconciliation/inv-reconciliation.service.ts",
    tables: ["levels"],
    buckets: "all derived buckets",
    grain: "full",
    reason:
      "Drift repair. Recomputes every bucket FROM the ledger rather than moving stock — the ledger stays the truth and this makes the projection agree with it again. Routing it through the kernel would mean posting compensating movements for drift whose cause is unknown.",
  },
  {
    file: "stock-engine/stock-projection.service.ts",
    tables: ["levels"],
    buckets: "on_order, outgoing_qty",
    grain: "full",
    reason:
      "Projections of documents, not of stock. `on_order` counts purchase order lines and `outgoing_qty` counts pick tasks; neither has a ledger movement behind it, because nothing has physically happened yet.",
  },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (/\.(spec|e2e-spec|db\.spec)\.ts$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

function census() {
  const files = SCAN_ROOTS.flatMap((root) => walk(root));
  const found = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const [key, table] of Object.entries(TABLES)) {
      const hits = writesIn(source, table);
      if (hits.length === 0) continue;
      found.push({
        file: relative(join(BACKEND_ROOT, "src", "modules", "inventory"), file).replace(/\\/g, "/"),
        table: key,
        hits,
      });
    }
  }

  return { files, found };
}

function main() {
  const json = process.argv.includes("--json");
  const { files, found } = census();

  const known = new Map(ACKNOWLEDGED.map((entry) => [entry.file, entry]));
  const unacknowledged = found.filter((f) => {
    const entry = known.get(f.file);
    return !entry || !entry.tables.includes(f.table);
  });

  /**
   * The floor. A scanner that matches nothing reports a perfectly clean module,
   * which is the failure mode this whole file exists to prevent elsewhere — so
   * it must find the kernel writing both tables before it is allowed to say
   * anything is clean.
   */
  const kernel = found.filter((f) => f.file === "stock-engine/movement-apply.service.ts");
  const kernelTables = new Set(kernel.map((f) => f.table));
  const vacuous = files.length < 100 || kernelTables.size !== 2;

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ scanned: files.length, found, unacknowledged, vacuous }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`Scanned ${files.length} inventory source files.\n\n`);
    process.stdout.write("STOCK WRITERS\n");
    for (const f of found) {
      const entry = known.get(f.file);
      const mark = entry && entry.tables.includes(f.table) ? "ok  " : "NEW ";
      const lines = f.hits.map((h) => h.line).join(", ");
      process.stdout.write(`  ${mark} ${f.table.padEnd(6)} ${f.file}:${lines}\n`);
      if (entry) process.stdout.write(`        buckets: ${entry.buckets}\n`);
    }
    process.stdout.write("\n");
  }

  if (vacuous) {
    process.stdout.write(
      `VACUITY GUARD — scanned ${files.length} files and found the kernel writing ${kernelTables.size} of 2 tables. ` +
        `The scan is broken; a clean result here would mean nothing.\n`,
    );
    process.exit(2);
  }

  /**
   * A writer that cannot name the whole grain.
   *
   * Presence of the column name in the file, not in the specific statement —
   * this is a line scanner, and a writer that mentions `ownership` nowhere at
   * all cannot be keying on it. That is exactly the shape both real bugs had:
   * the word appeared in neither the predicate nor anywhere else in
   * `reservation.service.ts`.
   */
  const grainGaps = [];
  for (const entry of ACKNOWLEDGED) {
    if (entry.grain !== "full") continue;
    const file = join(BACKEND_ROOT, "src", "modules", "inventory", entry.file);
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const missing = NATURAL_KEY.filter(
      (alternatives) => !alternatives.split("|").some((name) => source.includes(name)),
    );
    if (missing.length > 0) grainGaps.push({ file: entry.file, missing });
  }

  if (grainGaps.length > 0) {
    process.stdout.write(`FAIL — ${grainGaps.length} writer(s) never name part of the natural key:\n`);
    for (const gap of grainGaps)
      process.stdout.write(`  ${gap.file} — never mentions: ${gap.missing.join(", ")}\n`);
    process.stdout.write(
      `\n\`inv_stock_levels\` is keyed on all six. A writer that names a row by fewer writes to ` +
        `more rows than it means to, and the surplus is somebody else's stock.\n`,
    );
    process.exit(1);
  }

  /** An exception that no longer writes is a stale claim, and stale claims rot. */
  const stale = ACKNOWLEDGED.filter(
    (entry) => !found.some((f) => f.file === entry.file && entry.tables.includes(f.table)),
  );

  if (unacknowledged.length > 0) {
    process.stdout.write(`FAIL — ${unacknowledged.length} writer(s) outside MovementApplyService:\n`);
    for (const f of unacknowledged)
      for (const hit of f.hits)
        process.stdout.write(`  ${f.file}:${hit.line}  writes ${f.table}\n    ${hit.text}\n`);
    process.stdout.write(
      `\nStock mutations go through MovementApplyService. If this one genuinely cannot, ` +
        `add it to ACKNOWLEDGED in this file with the buckets it writes and why the kernel is wrong for it.\n`,
    );
    process.exit(1);
  }

  if (stale.length > 0) {
    process.stdout.write(`FAIL — ${stale.length} acknowledged writer(s) no longer write:\n`);
    for (const entry of stale) process.stdout.write(`  ${entry.file} — ${entry.tables.join(", ")}\n`);
    process.stdout.write(`\nRemove the entry. An exception nobody needs is an exception nobody reads.\n`);
    process.exit(1);
  }

  process.stdout.write(
    `PASS — ${found.length} writer site(s), all the kernel or acknowledged. ` +
      `1 open: reservation.service.ts (INV-40).\n`,
  );
}

function selfTest() {
  const cases = [
    [".insert(invStockLevels).values({", "levels", true],
    ["await tx.update(invStockLevels)", "levels", true],
    ["UPDATE inv_stock_levels dest", "levels", true],
    ["      INSERT INTO inv_stock_levels (org_id, product_variant_id)", "levels", true],
    ["const rows = await tx.select().from(invStockLevels)", "levels", false],
    ["// UPDATE inv_stock_levels would be wrong here", "levels", true],
    [".insert(invStockTransactions)", "ledger", true],
    ["SELECT * FROM inv_stock_transactions", "ledger", false],
  ];

  let failed = 0;
  for (const [line, table, expected] of cases) {
    const actual = writesIn(line, TABLES[table]).length > 0;
    if (actual !== expected) {
      failed += 1;
      process.stdout.write(`  self-test FAIL: ${JSON.stringify(line)} -> ${actual}, want ${expected}\n`);
    }
  }

  /**
   * The commented-out case above passes deliberately: a comment naming a write
   * is a false positive, and a false positive costs one line in ACKNOWLEDGED
   * while a false negative costs a corrupted ledger nobody notices.
   */
  if (failed > 0) {
    process.stdout.write(`SELF-TEST FAIL — ${failed} case(s)\n`);
    process.exit(3);
  }
  process.stdout.write(`SELF-TEST PASS — ${cases.length} cases\n`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
