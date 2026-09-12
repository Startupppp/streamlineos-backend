import { QueryCompilationError } from "./errors";

/**
 * The two primitives every byte of compiled SQL goes through.
 *
 * The whole safety argument of this module reduces to a claim about this file:
 * a compiled statement is made of (a) identifiers that passed `quoteIdent` and
 * (b) placeholders handed out by `ParamBag`. Nothing else is concatenated in.
 * If that holds, injection is not mitigated — there is no channel for it,
 * because a tenant's strings only ever reach the database as bind values.
 *
 * Keeping both here rather than inline in the compiler is not tidiness. It is so
 * the claim above is checkable by reading one short file, and so the specs can
 * attack the primitives directly instead of only through the compiler's front
 * door.
 */

/**
 * What a name has to look like before it may be emitted.
 *
 * Lowercase, ASCII, starts with a letter, 63 bytes or fewer — Postgres's own
 * identifier limit, past which a name is silently truncated and two distinct
 * columns can collide.
 *
 * Note what this forbids: a double quote. That is the entire reason the wrapping
 * in `quoteIdent` is safe rather than merely conventional. A quoting function
 * that escaped embedded quotes would work too, and would also be a function
 * somebody could later "optimise" into a bug. Refusing the character outright
 * cannot be weakened by accident.
 *
 * Uppercase is refused as well. Every physical name in this schema is lowercase,
 * so nothing legitimate needs it, and allowing it would mean `"Users"` and
 * `"users"` were different emittable identifiers for no gain.
 */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

export const isSafeIdentifier = (name: string): boolean =>
  SAFE_IDENTIFIER.test(name);

/**
 * The only function in this module that produces an identifier.
 *
 * It throws rather than sanitising. A sanitiser turns a wrong name into some
 * other name and carries on, which is how you end up querying a table nobody
 * asked for; a refusal stops.
 *
 * Callers pass registry-owned strings, never caller input — see the module
 * docblock in `registry.ts` for why that distinction is the one that matters.
 */
export function quoteIdent(name: string, path?: string): string {
  if (!isSafeIdentifier(name))
    throw new QueryCompilationError(
      "unsafe_identifier",
      `refusing to emit ${JSON.stringify(name)} as an identifier`,
      path,
    );
  return `"${name}"`;
}

/** A value that may cross the wire as a bind parameter. */
export type ParamValue = string | number | boolean;

/**
 * Hands out `$1`, `$2`, … and remembers what each one stands for.
 *
 * Ordinal placeholders rather than named ones because that is what
 * `postgres-js` speaks, and because the ordinal is assigned by *this* object at
 * the moment of binding: the compiler never computes a placeholder number
 * itself, so a fragment cannot be emitted referring to a parameter that was
 * never bound, nor two fragments to the same one.
 */
export class ParamBag {
  private readonly values: ParamValue[] = [];

  /**
   * Bind a value and get the placeholder that stands for it.
   *
   * `cast` is registry-derived, never caller-derived — it comes from the field's
   * declared type. It exists because a bare `$1` compared against a `timestamp`
   * column leaves Postgres to infer the parameter's type from context, and the
   * inference differs between a `=` comparison and an `IN` list. Naming the type
   * makes the comparison mean the same thing everywhere.
   */
  bind(value: ParamValue, cast?: string): string {
    this.values.push(value);
    const placeholder = `$${this.values.length}`;
    if (cast === undefined) return placeholder;
    if (!isSafeIdentifier(cast))
      throw new QueryCompilationError(
        "unsafe_identifier",
        `refusing to emit ${JSON.stringify(cast)} as a type cast`,
      );
    return `${placeholder}::${cast}`;
  }

  snapshot(): readonly ParamValue[] {
    return [...this.values];
  }

  get size(): number {
    return this.values.length;
  }
}

/**
 * Make a tenant's string mean itself inside a `LIKE` pattern.
 *
 * Without this, a `contains` filter for `100%` matches every row beginning
 * `100`, and `_` matches any character. That is not an injection — the value is
 * still a bind parameter and cannot become SQL — but it is a correctness bug
 * that reads like one, and on a filter over an email or an identifier it quietly
 * returns rows the caller did not ask for.
 *
 * Backslash first, or the escapes added below would themselves be escaped.
 * Backslash is Postgres's default `LIKE` escape character, so no `ESCAPE` clause
 * is needed — which matters, because an `ESCAPE '\'` clause would put the one
 * character this compiler otherwise never emits, a single quote, into the
 * statement and break the invariant the specs assert.
 */
export const escapeLikePattern = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
