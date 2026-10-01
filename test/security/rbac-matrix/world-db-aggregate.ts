import { Column, SQL, is } from "drizzle-orm";
import { AGGREGATES, compareRows, groupOrderTerm, scalar, type Lookup, type Subselect } from "./world-db-sql";
import { tokensOf, type Token } from "./world-db-tokens";
import { UnsupportedQuery } from "./world-db-values";

export interface GroupQuery<C> {
  readonly combos: readonly C[];
  readonly grouping: readonly unknown[] | null;
  readonly fields: unknown;
  readonly order: readonly unknown[];
  readonly lookupOf: (combo: C) => Lookup;
  readonly subselect: Subselect;
}

function isWord(token: Token | undefined, text: string): boolean {
  return token?.kind === "word" && token.text === text;
}

function outerAggregate(tokens: readonly Token[]): boolean {
  let nested = 0;
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    if (isWord(token, "(") && (nested > 0 || (next?.kind === "ident" && next.text === "select"))) nested += 1;
    else if (isWord(token, ")") && nested > 0) nested -= 1;
    else if (nested === 0 && token.kind === "ident" && AGGREGATES.has(token.text) && isWord(next, "(")) return true;
  }
  return false;
}

export function aggregated(fields: unknown): boolean {
  if (fields === null || fields === undefined || is(fields, Column)) return false;
  if (is(fields, SQL) || is(fields, SQL.Aliased)) return outerAggregate(tokensOf(fields));
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
