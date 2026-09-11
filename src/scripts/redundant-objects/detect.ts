/**
 * The pure half of `check:redundant-objects`: given the pg_catalog rows and the
 * schema declarations, decide which foreign keys, unique constraints, checks and
 * indexes are genuinely redundant and which merely overlap and must be kept.
 *
 * Two invariants this module exists to hold, both stated by PRD-C061's sibling
 * criterion PRD-C059 and both already paid for once in this repo:
 *
 *   1. STATISTICS NEVER JUSTIFY A DELETION. `idx_scan` and `n_live_tup` are
 *      carried on every finding for the report and are read by NO verdict
 *      branch below. A zero-scan index that is not structurally subsumed is not
 *      a finding at any scan count. `statisticsAreInert` proves it.
 *
 *   2. OVERLAP IS NOT REDUNDANCY. A leading-prefix pair is reported and always
 *      PRESERVED: migration 0999 dropped 337 narrow indexes on exactly the
 *      "the wider one covers it" argument and seven of them were measured
 *      regressions visible only under tenant skew.
 */

import type { LiveConstraint, LiveIndex, Overlap, PreserveReason } from "./catalog";

function keys(index: LiveIndex): string[] {
  return index.keydef === "" ? [] : index.keydef.split(",");
}

function isLeadingPrefix(narrow: readonly string[], wide: readonly string[]): boolean {
  if (narrow.length === 0 || narrow.length >= wide.length) return false;
  return narrow.every((key, position) => key === wide[position]);
}

function structural(index: LiveIndex): PreserveReason | null {
  if (index.is_primary) return "primary-key";
  if (index.backs_constraint) return "backs-a-constraint";
  return null;
}

function exactDuplicate(a: LiveIndex, b: LiveIndex): Overlap | null {
  if (a.keydef !== b.keydef || a.includedef !== b.includedef || a.predicate !== b.predicate) return null;
  const [candidate, survivor] = rankForRemoval(a, b);
  const blocked = structural(candidate);
  const uniquenessLost = candidate.is_unique && !survivor.is_unique;
  const preserveReason: PreserveReason | null = blocked ?? (uniquenessLost ? "distinct-uniqueness-guarantee" : null);
  return {
    id: `index:${candidate.schema}.${candidate.tbl}:${candidate.name}`,
    kind: "index",
    schema: candidate.schema,
    tbl: candidate.tbl,
    candidate: candidate.name,
    survivor: survivor.name,
    relation: "exact-duplicate",
    candidateKeys: candidate.keydef,
    verdict: preserveReason === null ? "REDUNDANT" : "PRESERVE",
    preserveReason,
    detail: `same access method, key vector and predicate — (${candidate.keydef}) ${candidate.predicate}`,
    candidateScans: candidate.idx_scan,
    survivorScans: survivor.idx_scan,
    rows: candidate.n_live_tup,
  };
}

/**
 * The droppable half of an exact pair is the one that carries the fewest
 * guarantees: never a primary key, never a constraint-backing index, never a
 * UNIQUE in favour of a non-unique. Ties break on name so the report is stable.
 */
function rankForRemoval(a: LiveIndex, b: LiveIndex): [LiveIndex, LiveIndex] {
  const weight = (index: LiveIndex): number =>
    (index.is_primary ? 4 : 0) + (index.backs_constraint ? 2 : 0) + (index.is_unique ? 1 : 0);
  const wa = weight(a);
  const wb = weight(b);
  if (wa !== wb) return wa < wb ? [a, b] : [b, a];
  return a.name < b.name ? [a, b] : [b, a];
}

function prefixOverlap(narrow: LiveIndex, wide: LiveIndex): Overlap | null {
  if (narrow.predicate !== wide.predicate) return null;
  if (narrow.includedef !== "") return null;
  if (!isLeadingPrefix(keys(narrow), keys(wide))) return null;
  const preserveReason: PreserveReason =
    structural(narrow) ?? (narrow.is_unique ? "distinct-uniqueness-guarantee" : "documented-access-pattern");
  return {
    id: `index:${narrow.schema}.${narrow.tbl}:${narrow.name}`,
    kind: "index",
    schema: narrow.schema,
    tbl: narrow.tbl,
    candidate: narrow.name,
    survivor: wide.name,
    relation: "leading-prefix",
    candidateKeys: narrow.keydef,
    verdict: "PRESERVE",
    preserveReason,
    detail: `(${narrow.keydef}) is a leading prefix of (${wide.keydef}); a narrow index is measurably cheaper under tenant skew and migration 0999 already paid for the opposite assumption`,
    candidateScans: narrow.idx_scan,
    survivorScans: wide.idx_scan,
    rows: narrow.n_live_tup,
  };
}

export function detectIndexOverlaps(indexes: readonly LiveIndex[]): Overlap[] {
  const byTable = new Map<string, LiveIndex[]>();
  for (const index of indexes) {
    const key = `${index.schema}.${index.tbl}.${index.am}`;
    const bucket = byTable.get(key);
    if (bucket === undefined) byTable.set(key, [index]);
    else bucket.push(index);
  }
  const out: Overlap[] = [];
  for (const bucket of byTable.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        if (a === undefined || b === undefined) continue;
        const duplicate = exactDuplicate(a, b);
        if (duplicate !== null) {
          out.push(duplicate);
          continue;
        }
        const forward = prefixOverlap(a, b);
        if (forward !== null) out.push(forward);
        const backward = prefixOverlap(b, a);
        if (backward !== null) out.push(backward);
      }
    }
  }
  return out.sort((x, y) => x.id.localeCompare(y.id));
}

const CONSTRAINT_KIND: Readonly<Record<string, Overlap["kind"]>> = {
  f: "foreign-key",
  u: "unique",
  c: "check",
};

export function detectConstraintDuplicates(constraints: readonly LiveConstraint[]): Overlap[] {
  const groups = new Map<string, LiveConstraint[]>();
  for (const constraint of constraints) {
    const key = `${constraint.schema}.${constraint.tbl}|${constraint.kind}|${constraint.signature}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [constraint]);
    else bucket.push(constraint);
  }
  const out: Overlap[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((a, b) => a.name.localeCompare(b.name));
    const survivor = sorted[0];
    if (survivor === undefined) continue;
    for (const candidate of sorted.slice(1)) {
      out.push({
        id: `${CONSTRAINT_KIND[candidate.kind] ?? candidate.kind}:${candidate.schema}.${candidate.tbl}:${candidate.name}`,
        kind: CONSTRAINT_KIND[candidate.kind] ?? "check",
        schema: candidate.schema,
        tbl: candidate.tbl,
        candidate: candidate.name,
        survivor: survivor.name,
        relation: "exact-duplicate",
        candidateKeys: candidate.signature,
        verdict: "REDUNDANT",
        preserveReason: null,
        detail: `identical to ${survivor.name} — ${candidate.definition}`,
        candidateScans: 0,
        survivorScans: 0,
        rows: 0,
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function colsetOf(constraint: LiveConstraint): string[] {
  const trimmed = constraint.colset.replace(/[{}]/g, "");
  return trimmed === "" ? [] : trimmed.split(",");
}

function isStrictSubset(inner: readonly string[], outer: readonly string[]): boolean {
  if (inner.length === 0 || inner.length >= outer.length) return false;
  return inner.every((value) => outer.includes(value));
}

/**
 * A single-column foreign key sitting beside the AR-02 composite
 * `(org_id, child_id) -> parent (org_id, id)` to the SAME parent is logically
 * implied by it. It is still never dropped here: the two carry independent
 * ON DELETE/ON UPDATE actions and the strictest one wins at delete time, so the
 * removal has to be sequenced with the referential-action reconciliation that
 * owns those actions. Detected, classified, preserved.
 */
export function detectForeignKeySubsumption(constraints: readonly LiveConstraint[]): Overlap[] {
  const foreignKeys = constraints.filter((constraint) => constraint.kind === "f");
  const byTable = new Map<string, LiveConstraint[]>();
  for (const foreignKey of foreignKeys) {
    const key = `${foreignKey.schema}.${foreignKey.tbl}|${foreignKey.parent}`;
    const bucket = byTable.get(key);
    if (bucket === undefined) byTable.set(key, [foreignKey]);
    else bucket.push(foreignKey);
  }
  const out: Overlap[] = [];
  for (const bucket of byTable.values()) {
    for (const narrow of bucket) {
      for (const wide of bucket) {
        if (narrow.name === wide.name) continue;
        if (!isStrictSubset(colsetOf(narrow), colsetOf(wide))) continue;
        out.push({
          id: `foreign-key:${narrow.schema}.${narrow.tbl}:${narrow.name}`,
          kind: "foreign-key",
          schema: narrow.schema,
          tbl: narrow.tbl,
          candidate: narrow.name,
          survivor: wide.name,
          relation: "leading-prefix",
          candidateKeys: narrow.colset,
          verdict: "PRESERVE",
          preserveReason: narrow.actions === wide.actions ? "implied-by-composite" : "distinct-referential-action",
          detail: `${narrow.definition} is implied by ${wide.name} (${wide.definition}); referential actions ${narrow.actions} vs ${wide.actions}`,
          candidateScans: 0,
          survivorScans: 0,
          rows: 0,
        });
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * A unique on (id) makes a unique on (org_id, id) logically implied. Every one of
 * those wider keys is nevertheless load-bearing: AR-02 requires every tenant-owned
 * child to reference its parent through `(org_id, id)`, and `check:tenant-relationships`
 * fails the build without it. Dropping the "redundant" half breaks every composite
 * foreign key that targets it, present or future.
 */
export function detectUniqueSubsumption(indexes: readonly LiveIndex[]): Overlap[] {
  const uniques = indexes.filter((index) => index.is_unique && index.predicate === "");
  const byTable = new Map<string, LiveIndex[]>();
  for (const index of uniques) {
    const key = `${index.schema}.${index.tbl}`;
    const bucket = byTable.get(key);
    if (bucket === undefined) byTable.set(key, [index]);
    else bucket.push(index);
  }
  const out: Overlap[] = [];
  const emitted = new Set<string>();
  for (const bucket of byTable.values()) {
    for (const narrow of bucket) {
      for (const wide of bucket) {
        if (narrow.name === wide.name) continue;
        const narrowColumns = keys(narrow).map((key) => key.split(":")[0] ?? key);
        const wideColumns = keys(wide).map((key) => key.split(":")[0] ?? key);
        if (!isStrictSubset(narrowColumns, wideColumns)) continue;
        const id = `index:${wide.schema}.${wide.tbl}:${wide.name}`;
        if (emitted.has(id)) continue;
        emitted.add(id);
        const preserveReason: PreserveReason = wide.is_fk_target
          ? "referenced-by-a-foreign-key"
          : wide.leads_with_tenant
            ? "tenant-anchored-fk-target"
            : wide.backs_constraint
              ? "backs-a-constraint"
              : "documented-access-pattern";
        out.push({
          id,
          kind: "unique",
          schema: wide.schema,
          tbl: wide.tbl,
          candidate: wide.name,
          survivor: narrow.name,
          relation: "leading-prefix",
          candidateKeys: wide.keydef,
          verdict: "PRESERVE",
          preserveReason,
          detail: `(${wide.keydef}) is implied by the narrower unique ${narrow.name} (${narrow.keydef}), and is kept because it is ${preserveReason.replace(/-/g, " ")}`,
          candidateScans: wide.idx_scan,
          survivorScans: narrow.idx_scan,
          rows: wide.n_live_tup,
        });
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function redundant(overlaps: readonly Overlap[]): Overlap[] {
  return overlaps.filter((overlap) => overlap.verdict === "REDUNDANT");
}

export function preserved(overlaps: readonly Overlap[]): Overlap[] {
  return overlaps.filter((overlap) => overlap.verdict === "PRESERVE");
}

/**
 * Re-runs the whole detector over the same catalog with every scan count and row
 * count replaced, and reports whether any verdict moved. The gate calls it on
 * every run and refuses to pass if a verdict is statistics-sensitive.
 */
export function statisticsAreInert(indexes: readonly LiveIndex[], constraints: readonly LiveConstraint[]): boolean {
  const perturbed = indexes.map((index, position) => ({
    ...index,
    idx_scan: position % 2 === 0 ? 0 : 10_000_000,
    n_live_tup: position % 2 === 0 ? 0 : 5_000_000,
  }));
  const before = [
    ...detectIndexOverlaps(indexes),
    ...detectUniqueSubsumption(indexes),
    ...detectConstraintDuplicates(constraints),
    ...detectForeignKeySubsumption(constraints),
  ];
  const after = [
    ...detectIndexOverlaps(perturbed),
    ...detectUniqueSubsumption(perturbed),
    ...detectConstraintDuplicates(constraints),
    ...detectForeignKeySubsumption(constraints),
  ];
  if (before.length !== after.length) return false;
  return before.every((overlap, position) => {
    const other = after[position];
    return other !== undefined && other.id === overlap.id && other.verdict === overlap.verdict && other.preserveReason === overlap.preserveReason;
  });
}
