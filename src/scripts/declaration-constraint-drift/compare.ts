/**
 * The comparison. Pure: no database, no filesystem, so `--self-test` can drive
 * every branch from fixtures. The four false-positive controls live here and
 * each is bite-proved in `self-test.ts`.
 */

import type { DeclaredTable, DriftReport, Finding, LiveConstraint, LiveIndex } from "./catalog";
import { coversAsPrefix, foreignKeyCovers, list } from "./catalog";


export function compare(
  declared: readonly DeclaredTable[],
  liveIndexes: readonly LiveIndex[],
  liveConstraints: readonly LiveConstraint[],
): DriftReport {
  const indexesByTable = new Map<string, LiveIndex[]>();
  for (const index of liveIndexes) {
    const key = `${index.schema}.${index.table}`;
    const bucket = indexesByTable.get(key);
    if (bucket === undefined) indexesByTable.set(key, [index]);
    else bucket.push(index);
  }
  const constraintsByTable = new Map<string, LiveConstraint[]>();
  for (const constraint of liveConstraints) {
    const key = `${constraint.schema}.${constraint.table}`;
    const bucket = constraintsByTable.get(key);
    if (bucket === undefined) constraintsByTable.set(key, [constraint]);
    else bucket.push(constraint);
  }

  const integrity: Finding[] = [];
  const performance: Finding[] = [];
  const nameDrift: Finding[] = [];
  const partialMismatch: Finding[] = [];
  const undeclared: Finding[] = [];
  const missingTables: string[] = [];
  const declaredKeys = new Set<string>();
  let comparedTables = 0;

  for (const table of declared) {
    const key = `${table.schema}.${table.table}`;
    declaredKeys.add(key);
    const indexes = indexesByTable.get(key);
    const constraints = constraintsByTable.get(key);
    if (indexes === undefined && constraints === undefined) {
      missingTables.push(key);
      continue;
    }
    comparedTables += 1;
    const live = indexes ?? [];
    const cons = constraints ?? [];
    const declaredNames = new Set<string>([
      ...table.uniques.map((unique) => unique.name),
      ...table.indexes.map((index) => index.name),
      ...table.foreignKeys.map((foreignKey) => foreignKey.name),
      ...table.checks,
    ]);

    // ---- uniqueness. Control A: index and constraint catalogs are one population.
    for (const declaredUnique of table.uniques) {
      const columns = list(declaredUnique.columns);
      const named =
        live.find((index) => index.name === declaredUnique.name) ??
        cons.find((constraint) => constraint.name === declaredUnique.name);
      const enforcedElsewhere =
        live.find((index) => index.unique && index.columns === columns && index.name !== declaredUnique.name) ??
        cons.find(
          (constraint) =>
            (constraint.kind === "u" || constraint.kind === "p") &&
            constraint.columns === columns &&
            constraint.name !== declaredUnique.name,
        );
      const id = `unique:${key}:${declaredUnique.name}`;
      if (named !== undefined) {
        const isUnique = "unique" in named ? named.unique : named.kind === "u" || named.kind === "p";
        if (named.columns === columns && isUnique) {
          if ("partial" in named && named.partial !== declaredUnique.partial)
            partialMismatch.push({
              id,
              verdict: "partial-mismatch",
              table: key,
              name: declaredUnique.name,
              detail: `declared partial=${String(declaredUnique.partial)}, live partial=${String(named.partial)} "${named.predicate}"`,
            });
          continue;
        }
        if (enforcedElsewhere !== undefined) {
          nameDrift.push({
            id,
            verdict: "name-drift",
            table: key,
            name: declaredUnique.name,
            detail: `the NAME is live on (${named.columns}); the declared columns (${columns}) are unique live as "${enforcedElsewhere.name}". Any 23505 handler naming "${declaredUnique.name}" for this tuple is dead.`,
          });
          continue;
        }
        integrity.push({
          id,
          verdict: "integrity",
          table: key,
          name: declaredUnique.name,
          detail: `live "${declaredUnique.name}" is on (${named.columns}), not the declared (${columns}), and nothing live enforces uniqueness over (${columns})`,
        });
        continue;
      }
      if (enforcedElsewhere !== undefined) {
        nameDrift.push({
          id,
          verdict: "name-drift",
          table: key,
          name: declaredUnique.name,
          detail: `uniqueness over (${columns}) IS enforced live by "${enforcedElsewhere.name}"; only the NAME is absent, so a 23505 handler naming "${declaredUnique.name}" is dead`,
        });
        continue;
      }
      integrity.push({
        id,
        verdict: "integrity",
        table: key,
        name: declaredUnique.name,
        detail: `no live unique constraint or unique index over (${columns}) — duplicates are insertable and any 23505 handler naming it is unreachable`,
      });
    }

    // ---- plain indexes. Controls B and D.
    for (const declaredIndex of table.indexes) {
      const columns = list(declaredIndex.columns);
      const id = `index:${key}:${declaredIndex.name}`;
      const named = live.find((index) => index.name === declaredIndex.name);
      const elsewhere = live.find(
        (index) => index.name !== declaredIndex.name && coversAsPrefix(index.columns, columns),
      );
      if (named !== undefined && named.columns === columns) {
        if (named.partial !== declaredIndex.partial)
          partialMismatch.push({
            id,
            verdict: "partial-mismatch",
            table: key,
            name: declaredIndex.name,
            detail: `declared partial=${String(declaredIndex.partial)}, live partial=${String(named.partial)} "${named.predicate}"`,
          });
        continue;
      }
      if (elsewhere !== undefined) {
        nameDrift.push({
          id,
          verdict: "name-drift",
          table: key,
          name: declaredIndex.name,
          detail:
            named === undefined
              ? `(${columns}) is indexed live as "${elsewhere.name}" (${elsewhere.columns}); only the NAME is absent`
              : `the NAME is live on (${named.columns}); the declared (${columns}) is covered by "${elsewhere.name}" (${elsewhere.columns})`,
        });
        continue;
      }
      performance.push({
        id,
        verdict: "performance",
        table: key,
        name: declaredIndex.name,
        detail: `no live index on (${columns}) and none covering it as a leading prefix`,
      });
    }

    // ---- foreign keys. Control C: match by shape, not by name.
    for (const declaredForeignKey of table.foreignKeys) {
      const id = `foreign-key:${key}:${declaredForeignKey.name}`;
      const covering = cons.find((constraint) => foreignKeyCovers(constraint, declaredForeignKey));
      if (covering !== undefined) {
        if (covering.name !== declaredForeignKey.name)
          nameDrift.push({
            id,
            verdict: "name-drift",
            table: key,
            name: declaredForeignKey.name,
            detail: `covered live by "${covering.name}" (${covering.columns}) -> ${covering.foreignSchema}.${covering.foreignTable}(${covering.foreignColumns})`,
          });
        continue;
      }
      integrity.push({
        id,
        verdict: "integrity",
        table: key,
        name: declaredForeignKey.name,
        detail: `no live foreign key from (${list(declaredForeignKey.columns)}) to ${declaredForeignKey.foreignTable}(${list(declaredForeignKey.foreignColumns)}) — orphan rows are insertable`,
      });
    }

    // ---- checks. Name only: normalising a Drizzle SQL fragment against
    //      pg_get_constraintdef is not reachable without a SQL parser.
    for (const check of table.checks) {
      if (cons.some((constraint) => constraint.kind === "c" && constraint.name === check)) continue;
      integrity.push({
        id: `check:${key}:${check}`,
        verdict: "integrity",
        table: key,
        name: check,
        detail: "no live CHECK constraint of that name — the invariant is enforced only in the service layer, if at all",
      });
    }

    // ---- present-but-undeclared.
    for (const index of live) {
      if (index.primary) continue;
      if (declaredNames.has(index.name)) continue;
      undeclared.push({
        id: `undeclared-index:${key}:${index.name}`,
        verdict: "undeclared",
        table: key,
        name: index.name,
        detail: `live${index.unique ? " UNIQUE" : ""} index on (${index.columns}) that no declaration names`,
      });
    }
    for (const constraint of cons) {
      if (constraint.kind === "p") continue;
      if (declaredNames.has(constraint.name)) continue;
      if (constraint.kind === "f" && table.foreignKeys.some((fk) => foreignKeyCovers(constraint, fk))) continue;
      undeclared.push({
        id: `undeclared-constraint:${key}:${constraint.name}`,
        verdict: "undeclared",
        table: key,
        name: constraint.name,
        detail: `live ${constraint.kind} constraint on (${constraint.columns}) that no declaration names`,
      });
    }
  }

  const order = (a: Finding, b: Finding): number => a.id.localeCompare(b.id);
  return {
    integrity: integrity.sort(order),
    performance: performance.sort(order),
    nameDrift: nameDrift.sort(order),
    partialMismatch: partialMismatch.sort(order),
    undeclared: undeclared.sort(order),
    comparedTables,
    missingTables: missingTables.sort(),
  };
}

export function unbaselined(findings: readonly Finding[], baseline: ReadonlySet<string>): Finding[] {
  return findings.filter((finding) => !baseline.has(finding.id));
}
