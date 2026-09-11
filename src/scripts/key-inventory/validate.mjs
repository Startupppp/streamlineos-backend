/**
 * The pure half of `check:key-inventory`. PRD-C057 does not ask for a report; it
 * asks for an inventory in which EVERY entry is KEEP, REFACTOR or REMOVE with its
 * owner and the concrete failure prevented. A partially classified inventory is
 * the failure mode this validates against, because it reads as complete.
 *
 * The prior wave's artifact is the worked example: registry-level, owners missing
 * on most rows, internally contradictory between its own sections, and stale
 * within a day. None of that is visible from the document itself — only from
 * re-deriving the population and comparing.
 */

export const REQUIRED_REGISTRIES = [
  "database.column",
  "database.primary-key",
  "database.foreign-key",
  "database.unique",
  "database.check",
  "database.index",
  "database.jsonb-column",
  "database.jsonb-key",
  "code.route",
  "code.permission",
  "code.module",
  "code.event",
  "code.command",
  "code.query-key",
  "code.cache-namespace",
  "code.environment-variable",
  "code.configuration",
  "code.feature-flag",
  "code.translation",
];

export const VERDICTS = new Set(["KEEP", "REFACTOR", "REMOVE"]);

/** Below these an extractor has broken; a clean result over an empty scan proves nothing. */
export const FLOORS = {
  "database.column": 10_000,
  "database.index": 3_000,
  "database.foreign-key": 2_000,
  "database.primary-key": 800,
  "database.unique": 500,
  "database.check": 100,
  "database.jsonb-column": 300,
  "database.jsonb-key": 1,
  "code.route": 3_000,
  "code.permission": 600,
  "code.module": 15,
  "code.event": 40,
  "code.command": 5,
  "code.query-key": 500,
  "code.cache-namespace": 20,
  "code.environment-variable": 50,
  "code.configuration": 30,
  "code.feature-flag": 5,
  "code.translation": 1,
};

const MIN_FAILURE_TEXT = 40;

export function validate(rows, { catalogCounts = null } = {}) {
  const problems = [];
  const byRegistry = new Map();
  for (const row of rows) {
    const bucket = byRegistry.get(row.registry);
    if (bucket === undefined) byRegistry.set(row.registry, [row]);
    else bucket.push(row);
  }

  for (const registry of REQUIRED_REGISTRIES) {
    const bucket = byRegistry.get(registry);
    if (bucket === undefined || bucket.length === 0) {
      problems.push({ kind: "missing-registry", registry, detail: "PRD-C057 names this registry and the inventory has no entries for it" });
      continue;
    }
    const floor = FLOORS[registry] ?? 1;
    if (bucket.length < floor)
      problems.push({
        kind: "below-floor",
        registry,
        detail: `${String(bucket.length)} entries against a floor of ${String(floor)} — the extractor is broken, not the codebase`,
      });
    const seen = new Set();
    for (const row of bucket) {
      if (seen.has(row.item)) problems.push({ kind: "duplicate-entry", registry, detail: row.item });
      seen.add(row.item);
      if (!VERDICTS.has(row.verdict)) problems.push({ kind: "unclassified", registry, detail: `${row.item} has verdict ${String(row.verdict)}` });
      if (typeof row.owner !== "string" || row.owner.trim() === "")
        problems.push({ kind: "no-owner", registry, detail: `${row.item} carries no owner` });
      if (typeof row.failurePrevented !== "string" || row.failurePrevented.trim().length < MIN_FAILURE_TEXT)
        problems.push({ kind: "no-failure-prevented", registry, detail: `${row.item} states no concrete failure prevented` });
      if (typeof row.evidence !== "string" || row.evidence.trim() === "")
        problems.push({ kind: "no-evidence", registry, detail: `${row.item} carries no command or file:line evidence` });
    }
  }

  if (catalogCounts !== null) {
    for (const [registry, expected] of Object.entries(catalogCounts)) {
      const actual = byRegistry.get(registry)?.length ?? 0;
      if (actual !== expected)
        problems.push({
          kind: "stale-against-catalog",
          registry,
          detail: `the inventory holds ${String(actual)} entries and pg_catalog holds ${String(expected)} — the artifact is stale, regenerate it`,
        });
    }
  }

  return problems;
}

export function summarise(rows) {
  const out = new Map();
  for (const row of rows) {
    const bucket = out.get(row.registry) ?? { entries: 0, KEEP: 0, REFACTOR: 0, REMOVE: 0 };
    bucket.entries += 1;
    if (bucket[row.verdict] !== undefined) bucket[row.verdict] += 1;
    out.set(row.registry, bucket);
  }
  return out;
}
