/**
 * The one error a description may produce.
 *
 * Split out of `query-compiler.ts` so that `query-bounds.ts` can subclass it
 * without the compiler and the bounds importing each other. The compiler calls
 * the bounds, the bounds raise this, and the compiler re-exports it — the cycle
 * that arrangement would otherwise create is a real problem here, because
 * `madge --circular` is part of this repository's checks.
 *
 * It is never a database error. Ticket 10's fifth criterion asks that a
 * description that cannot be answered fails as a statement about the
 * description, and that promise is only keepable if every refusal on the path
 * from description to statement is this type.
 */
export class QueryDescriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryDescriptionError";
  }
}
