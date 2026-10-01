import { Column, SQL, is } from "drizzle-orm";
import { AGGREGATES, compareRows, groupOrderTerm, scalar, type Lookup, type Subselect } from "./world-db-sql";
import { tokensOf } from "./world-db-tokens";
import { UnsupportedQuery } from "./world-db-values";

export interface GroupQuery<C> {
  readonly combos: readonly C[];
  readonly grouping: readonly unknown[] | null;
  readonly fields: unknown;
  readonly order: readonly unknown[];
  readonly lookupOf: (combo: C) => Lookup;
  readonly subselect: Subselect;
}

export function aggregated(fields: unknown): boolean {
  if (fields === null || fields === undefined || is(fields, Column)) return false;
  if (is(fields, SQL) || is(fields, SQL.Aliased)) {
    const tokens = tokensOf(fields);
    return tokens.some((token, index) => {
      const next = tokens[index + 1];
      return token.kind === "ident" && AGGREGATES.has(token.text) && next?.kind === "word" && next.text === "(";
    });
  }
  if (typeof fields !== "object") return false;
  return Object.values(fields).some(aggregated);
}

function projectGroup(fields: unknown, base: Lookup, subselect: Subselect, lookups: readonly Lookup[]): unknown {
  if (is(fields, Column)) return base(fields);
  if (is(fields, SQL) || is(fields, SQL.Aliased)) return scalar(fields, base, subselect, lookups);
  if (fields === null || typeof fields !== "object") throw new UnsupportedQuery("grouped select without a projection");
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, projectGroup(value, base, subselect, lookups)]));
}

export function groupedRows<C>(query: GroupQuery<C>): unknown[] {
  const keys = (query.grouping ?? []).map((key) => {
    if (!is(key, Column)) throw new UnsupportedQuery("groupBy over a non-column");
    return key;
  });
  const groups = new Map<string, C[]>();
  if (keys.length === 0) groups.set("", [...query.combos]);
  else
    for (const combo of query.combos) {
      const lookup = query.lookupOf(combo);
      const id = JSON.stringify(keys.map((key) => lookup(key)));
      groups.set(id, [...(groups.get(id) ?? []), combo]);
    }
  const shaped = [...groups.values()].map((members) => {
    const lookups = members.map(query.lookupOf);
    const base: Lookup = (column) => {
      if (!keys.includes(column)) throw new UnsupportedQuery(`column ${column.name} neither grouped nor aggregated`);
      return lookups[0](column);
    };
    return {
      row: projectGroup(query.fields, base, query.subselect, lookups),
      terms: query.order.map((node) => groupOrderTerm(node, base, query.subselect, lookups)),
    };
  });
  return shaped
    .sort((left, right) => {
      for (const [index, term] of left.terms.entries()) {
        const order = compareRows(term.value, right.terms[index].value);
        if (order !== 0) return term.descending ? -order : order;
      }
      return 0;
    })
    .map((group) => group.row);
}
