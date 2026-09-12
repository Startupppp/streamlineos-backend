/**
 * The one error the statement parser throws.
 *
 * Its own file because every piece of the parser raises it — the date reader,
 * the amount reader, the CSV reader and the mapping — and the importer turns
 * it into a 400 with `instanceof`, so there must be exactly one class.
 */
export class StatementCsvError extends Error {
  constructor(
    message: string,
    /** 1-based row number in the source file, when the problem is on one row. */
    readonly rowNumber?: number,
    readonly column?: string,
  ) {
    super(message);
    this.name = "StatementCsvError";
  }
}
