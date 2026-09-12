import { PgDialect } from "drizzle-orm/pg-core";
import { compileQuery } from "./compile";
import { isSafeIdentifier, quoteIdent, ParamBag } from "./emit";
import { QueryCompilationError } from "./errors";
import { toDrizzleSql } from "./to-drizzle-sql";
import { BASE_ALIAS, REPORTING_REGISTRY } from "./registry";
import type { QueryDescription } from "./query-description";

/**
 * The file to read before trusting this module.
 *
 * The claim under test is not "injection attempts are escaped". It is that they
 * are **unrepresentable**: a tenant supplies a data structure, and no field of
 * that structure has a path to the text of a statement. So these tests do not
 * check that hostile input is neutralised — they check that hostile input either
 * lands in a bind parameter, where it is inert by construction, or is refused by
 * name before anything is emitted.
 *
 * The distinction matters because an escaping bug is a one-character regression
 * and a missing channel is not a regression at all. If somebody later adds a
 * `havingExpression: string` to the description, the structural tests at the
 * bottom of this file fail — not because they know about `having`, but because
 * they assert that every byte of the output is either a registry identifier or a
 * placeholder, and a pasted expression is neither.
 */

const ORG = "org_target";

/**
 * Payloads aimed at each field in turn.
 *
 * Deliberately more than SQL: the prototype names are here because looking a
 * caller's string up in a plain object reaches `Object.prototype`, so
 * `field: "constructor"` finds a function and a naive truthiness check treats it
 * as a hit. That bug produces a crash or, worse, an emit with `undefined` in it,
 * and it has nothing to do with quoting.
 */
const HOSTILE_NAMES = [
  "'; DROP TABLE deals; --",
  `" OR "1"="1`,
  `stage" , (SELECT password FROM users) AS "x`,
  "stage); DELETE FROM deals WHERE (1=1",
  "stage) OR (1=1",
  "1=1",
  "pg_sleep(10)",
  "deals AS s2 CROSS JOIN users",
  "stage/*comment*/",
  "stage--",
  "stage\nUNION ALL SELECT 1",
  "stage\u0000",
  "STAGE",
  "org_id",
  "organization_id",
  "password_hash",
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "party.name.extra",
  "party..name",
  ".stage",
  "party.",
  "",
  " ",
  "s",
  "j0",
] as const;

/** Values a tenant might type into a filter box in anger. They must all work. */
const HOSTILE_VALUES = [
  "'; DROP TABLE deals; --",
  `" OR "1"="1`,
  "\\",
  "100%",
  "a_b",
  "$1",
  "$2",
  "'",
  '"',
  ";",
  "--",
  "/*",
  "WON' OR '1'='1",
] as const;

const baseline: QueryDescription = {
  source: "deals",
  select: [{ kind: "field", field: "stage" }],
  limit: 10,
};

const compile = (description: QueryDescription) =>
  compileQuery(description, { organizationId: ORG, requester: { userId: "user_1", scope: "all" as const } });

const refusal = (fn: () => unknown): QueryCompilationError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof QueryCompilationError) return error;
    /**
     * The cause is attached rather than stringified away. A compiler that throws
     * a `TypeError` instead of refusing is the most alarming failure this suite
     * can hit — it means an unenumerated path was reached — and the stack of the
     * original is the only thing that says where.
     */
    throw new Error(`expected a QueryCompilationError, got ${String(error)}`, {
      cause: error,
    });
  }
  throw new Error("expected the compiler to refuse, but it compiled");
};

/** Every identifier the registry could legitimately put in a statement. */
const registryIdentifiers = (): Set<string> => {
  const names = new Set<string>([BASE_ALIAS]);
  for (const source of REPORTING_REGISTRY.values()) {
    names.add(source.table);
    names.add(source.organizationColumn);
    if (source.softDeleteColumn) names.add(source.softDeleteColumn);
    for (const field of Object.values(source.fields)) names.add(field.column);
    for (const join of Object.values(source.joins ?? {})) {
      names.add(join.alias);
      names.add(join.table);
      names.add(join.organizationColumn);
      names.add(join.localColumn);
      names.add(join.foreignColumn);
      if (join.softDeleteColumn) names.add(join.softDeleteColumn);
      for (const field of Object.values(join.fields)) names.add(field.column);
    }
  }
  return names;
};

describe("a tenant cannot reach the text of a statement", () => {
  // ── The channel that does not exist ────────────────────────────────────────

  describe("names are looked up, never interpolated", () => {
    it.each(HOSTILE_NAMES)("refuses %j as a source", (name) => {
      const error = refusal(() => compile({ ...baseline, source: name }));
      expect(error.code).toBe("unknown_source");
    });

    it.each(HOSTILE_NAMES)("refuses %j as a selected field", (name) => {
      const error = refusal(() =>
        compile({ ...baseline, select: [{ kind: "field", field: name }] }),
      );
      expect(error.code).toBe("unknown_field");
    });

    it.each(HOSTILE_NAMES)("refuses %j as a filtered field", (name) => {
      const error = refusal(() =>
        compile({
          ...baseline,
          filter: { kind: "compare", field: name, operator: "is_null" },
        }),
      );
      expect(error.code).toBe("unknown_field");
    });

    it.each(HOSTILE_NAMES)("refuses %j as a grouping key", (name) => {
      const error = refusal(() =>
        compile({
          ...baseline,
          select: [{ kind: "aggregate", aggregate: "count" }],
          groupBy: [name],
        }),
      );
      expect(error.code).toBe("unknown_field");
    });

    it.each(HOSTILE_NAMES)("refuses %j as an aggregated field", (name) => {
      const error = refusal(() =>
        compile({ ...baseline, select: [{ kind: "aggregate", aggregate: "sum", field: name }] }),
      );
      expect(error.code).toBe("unknown_field");
    });

    it("refuses the tenant column itself, because the registry is an allow-list", () => {
      /**
       * `org_id` is a real column on `deals` and is not a registered field. If
       * this ever compiles, the registry has stopped being an enumeration of
       * what may be queried and become a filter over the whole table — which is
       * the difference between "these ten columns" and "every column we did not
       * think to exclude".
       */
      expect(refusal(() => compile({ ...baseline, select: [{ kind: "field", field: "org_id" }] })).code).toBe(
        "unknown_field",
      );
    });

    it("refuses a prototype name rather than finding it on Object.prototype", () => {
      /**
       * The specific bug: `registry["__proto__"]` on a plain object is truthy,
       * so a lookup guarded by truthiness proceeds with `Object.prototype` as
       * the source spec — an object with no `table`, which reaches the emit path
       * carrying `undefined`. `Map` has no prototype chain to walk.
       */
      expect(REPORTING_REGISTRY.get("__proto__")).toBeUndefined();
      expect(REPORTING_REGISTRY.get("constructor")).toBeUndefined();
      expect(refusal(() => compile({ ...baseline, source: "__proto__" })).code).toBe("unknown_source");
    });
  });

  describe("operators, aggregates and directions are enumerations", () => {
    it("refuses an operator that is a fragment", () => {
      expect(
        refusal(() =>
          compile({
            ...baseline,
            filter: {
              kind: "compare",
              field: "stage",
              operator: "= 'WON' OR 1=1 --" as never,
              value: "x",
            },
          }),
        ).code,
      ).toBe("unknown_operator");
    });

    it("refuses an aggregate that is a function call", () => {
      expect(
        refusal(() =>
          compile({
            ...baseline,
            select: [
              { kind: "aggregate", aggregate: "pg_sleep" as never, field: "value_minor" },
            ],
          }),
        ).code,
      ).toBe("unknown_aggregate");
    });

    it("refuses a sort direction that carries a clause", () => {
      expect(
        refusal(() =>
          compile({
            ...baseline,
            orderBy: [{ select: 0, direction: "asc; DROP TABLE deals" as never }],
          }),
        ).code,
      ).toBe("malformed_description");
    });

    it("refuses a non-integer sort target rather than emitting it", () => {
      /**
       * `orderBy.select` is the one numeric field that reaches the statement's
       * shape. It indexes an array, so a string here would be a lookup miss
       * rather than text — but a fractional or negative index would index
       * nothing while looking plausible, so all three are refused by name.
       */
      for (const select of ["0" as never, 0.5, -1, Number.NaN]) {
        expect(refusal(() => compile({ ...baseline, orderBy: [{ select, direction: "asc" }] })).code).toBe(
          "invalid_order_target",
        );
      }
    });
  });

  // ── The channel that exists, and is inert ─────────────────────────────────

  describe("values reach the database only as bind parameters", () => {
    /**
     * The invariant, stated as an equality rather than as an absence.
     *
     * A `not.toContain(value)` assertion looks like the right test and is not:
     * it passes vacuously for a value like `"` that legitimately appears in
     * every statement as an identifier quote, and it fails spuriously for a
     * value like `$1` that matches a placeholder the compiler emitted for its
     * own reasons. Both cases are exactly the ones an attacker would probe.
     *
     * What is actually being claimed is stronger and has neither hole: **the
     * text of the statement does not depend on the value at all.** Compiling
     * with a hostile value and with a benign one produces the same bytes. If any
     * channel existed from a value to the statement, these two would differ.
     */
    const benign = compile({
      ...baseline,
      filter: { kind: "compare", field: "stage", operator: "eq", value: "WON" },
    });

    it.each(HOSTILE_VALUES)("compiles %j to the same statement as a benign value", (value) => {
      const compiled = compile({
        ...baseline,
        filter: { kind: "compare", field: "stage", operator: "eq", value },
      });

      expect(compiled.text).toBe(benign.text);
      expect(compiled.params).toEqual([ORG, value, 10, 0]);
    });

    it.each(HOSTILE_VALUES)("carries %j through an IN list without changing the statement", (value) => {
      const benignList = compile({
        ...baseline,
        filter: { kind: "compare", field: "stage", operator: "in", values: ["WON", "LOST"] },
      });
      const compiled = compile({
        ...baseline,
        filter: { kind: "compare", field: "stage", operator: "in", values: [value, value] },
      });

      expect(compiled.text).toBe(benignList.text);
      expect(compiled.text).toContain(`"s"."stage" IN ($2, $3)`);
      expect(compiled.params).toEqual([ORG, value, value, 10, 0]);
    });

    it("refuses a NUL byte, which the driver could not have sent anyway", () => {
      /**
       * Not an injection — a NUL in a bind parameter is as inert as any other
       * byte. It is refused because Postgres `text` cannot hold one, so
       * `postgres-js` raises instead of sending it: without this check a filter
       * value with an embedded NUL is a 500 from inside the tenant transaction
       * on what is plainly a bad request.
       */
      expect(
        refusal(() =>
          compile({
            ...baseline,
            filter: { kind: "compare", field: "stage", operator: "eq", value: "WON\u0000" },
          }),
        ).code,
      ).toBe("value_type_mismatch");
    });

    it("does not mistake a value that looks like a placeholder for one", () => {
      /**
       * `toDrizzleSql` rebuilds the statement by splitting on `$n`. If a
       * tenant's literal `"$1"` were ever in the text, that split would treat it
       * as a placeholder and bind the organisation id in its place — a value
       * confusion that produces no error and the wrong rows. It cannot happen
       * because values are not in the text, and this pins that down at the point
       * where it would matter.
       */
      const compiled = compile({
        ...baseline,
        filter: { kind: "compare", field: "stage", operator: "eq", value: "$1" },
      });
      const query = new PgDialect().sqlToQuery(toDrizzleSql(compiled));

      expect(query.params).toEqual([ORG, "$1", 10, 0]);
      expect(query.sql).toContain("$2");
    });

    it("treats a wildcard in a search box as a character, not a pattern", () => {
      /**
       * Not an injection — the value was always a parameter — but the bug that
       * looks most like one. A `contains` search for `100%` that matched
       * everything beginning `100` would be read as a broken filter by a person
       * and as a leak by an auditor.
       */
      const compiled = compile({
        ...baseline,
        filter: { kind: "compare", field: "name", operator: "contains", value: "100%_x" },
      });
      expect(compiled.params[1]).toBe("%100\\%\\_x%");
    });

    it("escapes the escape character first, so a backslash cannot smuggle a wildcard", () => {
      const compiled = compile({
        ...baseline,
        filter: { kind: "compare", field: "name", operator: "starts_with", value: "\\%" },
      });
      /**
       * If `%` were escaped before `\`, the value `\%` would become `\\%` — a
       * literal backslash followed by a live wildcard, which is precisely the
       * pattern the escaping exists to prevent.
       */
      expect(compiled.params[1]).toBe("\\\\\\%%");
    });
  });

  // ── The structural invariants ─────────────────────────────────────────────

  describe("the shape of every statement this compiler can produce", () => {
    /**
     * A corpus that exercises each emit path at least once, threaded with
     * hostile values so the invariants below are asserted against statements
     * that a tenant actively tried to break.
     */
    const corpus = (): QueryDescription[] => [
      baseline,
      {
        source: "deals",
        select: [
          { kind: "field", field: "party.industry" },
          { kind: "aggregate", aggregate: "count" },
          { kind: "aggregate", aggregate: "count_distinct", field: "assigned_to_id" },
          { kind: "aggregate", aggregate: "sum", field: "value_minor" },
          { kind: "aggregate", aggregate: "avg", field: "probability" },
          { kind: "aggregate", aggregate: "min", field: "created_at" },
          { kind: "aggregate", aggregate: "max", field: "expected_close_date" },
        ],
        groupBy: ["party.industry"],
        orderBy: [{ select: 3, direction: "desc" }],
        filter: {
          kind: "and",
          nodes: [
            { kind: "compare", field: "stage", operator: "in", values: ["'; --", "WON"] },
            { kind: "not", node: { kind: "compare", field: "lost_reason", operator: "is_not_null" } },
            {
              kind: "or",
              nodes: [
                { kind: "compare", field: "name", operator: "contains", value: "' OR 1=1 --" },
                { kind: "compare", field: "name", operator: "starts_with", value: '"' },
                { kind: "compare", field: "name", operator: "ends_with", value: ";" },
                { kind: "compare", field: "value_minor", operator: "between", from: 1, to: 2 },
                { kind: "compare", field: "created_at", operator: "gte", value: "2026-01-01T00:00:00Z" },
                { kind: "compare", field: "expected_close_date", operator: "lt", value: "2026-12-31" },
                { kind: "compare", field: "party.name", operator: "ne", value: "'" },
              ],
            },
          ],
        },
        limit: 100,
        offset: 10,
      },
      {
        source: "activities",
        select: [
          { kind: "field", field: "kind" },
          { kind: "aggregate", aggregate: "count" },
        ],
        groupBy: ["kind"],
        limit: 5,
      },
      {
        source: "parties",
        select: [{ kind: "field", field: "industry" }],
        filter: { kind: "compare", field: "status", operator: "not_in", values: ["x'"] },
        limit: 5,
      },
    ];

    it("contains no string literal at all, so there is nowhere for a value to hide", () => {
      /**
       * The strongest statement this suite can make, and the one that survives
       * changes to the compiler nobody told this file about. A single quote is
       * how a literal begins in SQL; if none is ever emitted, no tenant string
       * is in the statement, whatever new clause somebody adds. `ESCAPE '\'` is
       * the clause this would have caught — which is why `contains` relies on
       * Postgres's default escape character instead.
       */
      for (const description of corpus()) {
        const { text } = compile(description);
        expect(text).not.toContain("'");
        expect(text).not.toContain(";");
        expect(text).not.toContain("--");
        expect(text).not.toContain("/*");
        expect(text).not.toContain("\\");
      }
    });

    it("quotes only identifiers the registry owns, plus its own output aliases", () => {
      /**
       * The companion to the test above. That one says no *values* are in the
       * text; this one says no *names* are either, beyond the enumerated set. A
       * caller-supplied alias, a pasted expression, or a table name that came
       * from anywhere but `registry.ts` fails here.
       */
      const allowed = registryIdentifiers();

      for (const description of corpus()) {
        const compiled = compile(description);
        for (const alias of compiled.columns) allowed.add(alias.alias);

        const quoted = [...compiled.text.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
        expect(quoted.length).toBeGreaterThan(0);
        for (const name of quoted) {
          expect(isSafeIdentifier(name)).toBe(true);
          expect(allowed).toContain(name);
        }
      }
    });

    it("scopes every table it touches to the caller's organisation", () => {
      /**
       * Counted rather than sampled: one predicate for the base table and one
       * per join, all bound to `$1`. A join that arrived without its own
       * predicate would read another tenant's parties through this tenant's
       * deals, and would look completely normal in a code review.
       */
      for (const description of corpus()) {
        const compiled = compile(description);
        const joins = (compiled.text.match(/LEFT JOIN/g) ?? []).length;
        const scoped = (compiled.text.match(/= \$1(?![0-9])/g) ?? []).length;

        expect(compiled.params[0]).toBe(ORG);
        expect(scoped).toBe(joins + 1);
      }
    });

    it("survives the round trip to the driver with its parameters still out of band", () => {
      /**
       * The end of the chain, and the only place Drizzle is involved. Running it
       * through the real `PgDialect` proves the claim about the *executed*
       * statement rather than about our intermediate string — offline, with no
       * database, because the dialect is a pure serialiser.
       */
      const dialect = new PgDialect();
      for (const description of corpus()) {
        const compiled = compile(description);
        const query = dialect.sqlToQuery(toDrizzleSql(compiled));

        expect(query.sql).not.toContain("'");
        expect(query.params[0]).toBe(ORG);
        for (const value of compiled.params) expect(query.params).toContain(value);
      }
    });
  });

  // ── The primitives, attacked directly ─────────────────────────────────────

  describe("the emit primitives refuse rather than sanitise", () => {
    it.each([
      `a"b`,
      `a";DROP`,
      "Users",
      "1abc",
      "",
      " ",
      "a b",
      "a-b",
      "a.b",
      "a\u0000b",
      "\u{1d4c8}\u{1d4c9}\u{1d4b6}\u{1d454}\u{1d452}",
      `${"x".repeat(64)}`,
    ])("refuses to emit %j as an identifier", (name) => {
      expect(() => quoteIdent(name)).toThrow(QueryCompilationError);
      expect(isSafeIdentifier(name)).toBe(false);
    });

    it("accepts exactly the shape every registry name has", () => {
      expect(quoteIdent("value_minor")).toBe(`"value_minor"`);
      expect(isSafeIdentifier("x".repeat(63))).toBe(true);
    });

    it("refuses a cast that is not a plain type name", () => {
      /**
       * The cast is registry-derived today. It is checked anyway because it is
       * the one string in `ParamBag` that is not a number, and a future field
       * type whose cast was `numeric) OR (1=1` would otherwise be the one way
       * back into the text.
       */
      expect(() => new ParamBag().bind(1, "numeric) OR (1=1")).toThrow(QueryCompilationError);
    });

    it("hands out ordinals itself, so no fragment can name an unbound parameter", () => {
      const bag = new ParamBag();
      expect(bag.bind("a")).toBe("$1");
      expect(bag.bind(2, "numeric")).toBe("$2::numeric");
      expect(bag.snapshot()).toEqual(["a", 2]);
    });
  });

  // ── The type is not the gate ──────────────────────────────────────────────

  it("refuses a hostile description that never went through a DTO", () => {
    /**
     * The scenario this covers is not a hypothetical: a saved report is JSON in
     * a `jsonb` column, validated by whatever the DTO looked like the day it was
     * written, and read back into a `QueryDescription`-typed variable years
     * later. TypeScript is gone at run time, so if the compiler trusted its
     * parameter's type, every saved row would be an unvalidated input.
     *
     * This is the compiler being handed exactly that: an object that typechecks
     * only because of the cast, with hostile content in every field.
     */
    const smuggled = {
      source: "deals",
      select: [{ kind: "field", field: `stage" FROM users --` }],
      groupBy: [`stage"`],
      filter: { kind: "compare", field: "1=1", operator: "eq", value: "x" },
      orderBy: [{ select: 0, direction: "asc" }],
      limit: 10,
    } as unknown as QueryDescription;

    expect(refusal(() => compile(smuggled)).code).toBe("unknown_field");
  });

  it("refuses a description whose filter is a bare string", () => {
    expect(
      refusal(() =>
        compile({ ...baseline, filter: "1=1 OR true" as unknown as QueryDescription["filter"] }),
      ).code,
    ).toBe("malformed_description");
  });
});
