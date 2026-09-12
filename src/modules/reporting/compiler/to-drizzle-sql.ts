import { Param, SQL, StringChunk, type SQLChunk } from "drizzle-orm";
import { QueryCompilationError } from "./errors";
import type { CompiledQuery } from "./compile";

/**
 * The seam between the pure compiler and the driver.
 *
 * The compiler emits `{ text, params }` with `$n` placeholders because that
 * shape is testable without a database, comparable across runs, and small enough
 * to put in an audit row. Drizzle wants an `SQL` object. This converts one to
 * the other, and it is the only place in the module where the two meet.
 *
 * The conversion has to preserve the property the compiler establishes, so it
 * does not paste the values in — it splits the text on its placeholders and
 * rebuilds it as alternating `StringChunk`s and `Param`s. Drizzle then renumbers
 * the parameters itself when it serialises, and the driver sends them out of
 * band. A tenant's string never becomes part of a statement at any point in the
 * chain.
 *
 * Why not have the compiler build `SQL` objects directly and skip this file: an
 * `SQL` object is opaque, and asserting things about one means serialising it
 * through a dialect — so every adversarial spec would depend on Drizzle's
 * internals, and the invariants that matter ("no single quote appears anywhere")
 * would be assertions about Drizzle's output rather than about our own. A plain
 * string is the thing worth making claims about.
 */

/** `$1`, `$2`, … and nothing else. `$1x` is not a placeholder, it is a mistake. */
const PLACEHOLDER = /\$(\d+)/g;

export function toDrizzleSql(compiled: CompiledQuery): SQL {
  const chunks: SQLChunk[] = [];
  let cursor = 0;
  /**
   * Distinct ordinals, not occurrences. The organisation predicate binds `$1`
   * once and the compiler emits that same placeholder in the base `WHERE` and
   * again in every join's `ON`, so counting occurrences would report more
   * placeholders than parameters on any query that touches a relation.
   *
   * Each occurrence still becomes its own `Param` chunk carrying the same value,
   * which Drizzle renumbers on serialisation — three copies of one organisation
   * id rather than three references to one parameter. Identical semantics, and
   * it keeps this function from having to model parameter reuse.
   */
  const bound = new Set<number>();

  for (const match of compiled.text.matchAll(PLACEHOLDER)) {
    const at = match.index ?? 0;
    if (at > cursor) chunks.push(new StringChunk(compiled.text.slice(cursor, at)));

    const ordinal = Number(match[1]);
    const value = compiled.params[ordinal - 1];
    if (value === undefined)
      /**
       * Unreachable through `compileQuery` — `ParamBag` is what assigns the
       * ordinals, so every placeholder it produced has a value behind it. It is
       * checked anyway because the alternative is silently binding `undefined`,
       * which `postgres-js` sends as NULL: a predicate that quietly matches
       * nothing, on a report nobody would think to distrust.
       */
      throw new QueryCompilationError(
        "malformed_description",
        `compiled statement references $${ordinal} but only ${compiled.params.length} parameters were bound`,
      );

    chunks.push(new Param(value));
    cursor = at + match[0].length;
    bound.add(ordinal);
  }

  if (cursor < compiled.text.length) chunks.push(new StringChunk(compiled.text.slice(cursor)));

  if (bound.size !== compiled.params.length)
    /**
     * A bound value with no placeholder is the mirror image of the case above
     * and just as bad: the parameter lists would line up by count but not by
     * position, so every predicate after the orphan would compare against the
     * wrong value — including, in the worst arrangement, the organisation
     * predicate. Refuse rather than run.
     */
    throw new QueryCompilationError(
      "malformed_description",
      `compiled statement references ${bound.size} distinct parameters but ${compiled.params.length} were bound`,
    );

  return new SQL(chunks);
}
