/**
 * Statement dates under a declared layout.
 *
 * The date format is declared, never guessed: `DD/MM/YYYY` and `MM/DD/YYYY`
 * share a regex and differ only in field order, so there is no heuristic here.
 * A caller that does not name one gets a rejection, because guessing wrong
 * silently moves money between months.
 */
import { assertIsoDate, FiscalCalendarError } from "../../kernel/fiscal-calendar";
import { StatementCsvError } from "./statement-csv-error";

/**
 * Every layout the importer accepts, spelled out. `DD/MM/YYYY` and
 * `MM/DD/YYYY` share a regex and differ only in field order — which is exactly
 * why one of them has to be named by the caller.
 */
export const SUPPORTED_DATE_FORMATS = [
  "YYYY-MM-DD",
  "YYYY/MM/DD",
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "DD-MM-YYYY",
  "MM-DD-YYYY",
  "DD.MM.YYYY",
  "DD-MMM-YYYY",
  "MMM DD, YYYY",
] as const;

export type StatementDateFormat = (typeof SUPPORTED_DATE_FORMATS)[number];

type DatePart = "Y" | "M" | "D" | "MON";

interface DateLayout {
  readonly pattern: RegExp;
  readonly order: readonly [DatePart, DatePart, DatePart];
}

const DATE_LAYOUTS: Readonly<Record<StatementDateFormat, DateLayout>> = Object.freeze({
  "YYYY-MM-DD": { pattern: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, order: ["Y", "M", "D"] },
  "YYYY/MM/DD": { pattern: /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, order: ["Y", "M", "D"] },
  "DD/MM/YYYY": { pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: ["D", "M", "Y"] },
  "MM/DD/YYYY": { pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: ["M", "D", "Y"] },
  "DD-MM-YYYY": { pattern: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, order: ["D", "M", "Y"] },
  "MM-DD-YYYY": { pattern: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, order: ["M", "D", "Y"] },
  "DD.MM.YYYY": { pattern: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, order: ["D", "M", "Y"] },
  "DD-MMM-YYYY": { pattern: /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/, order: ["D", "MON", "Y"] },
  "MMM DD, YYYY": { pattern: /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/, order: ["MON", "D", "Y"] },
});

const MONTH_ABBREVIATIONS: Readonly<Record<string, number>> = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
});

/** A trailing clock reading — banks love `2026-04-03 10:22:00` in a date column. */
const TRAILING_TIME = /[\sT]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*([AP]\.?M\.?)?(\s*[A-Z]{2,4})?$/i;

export function isSupportedDateFormat(value: string): value is StatementDateFormat {
  return SUPPORTED_DATE_FORMATS.some((f) => f === value);
}

/**
 * `raw` under the declared `format`, as an ISO `YYYY-MM-DD`.
 *
 * `parseStatementDate("03/04/2026", "DD/MM/YYYY")` is `2026-04-03`;
 * `parseStatementDate("03/04/2026", "MM/DD/YYYY")` is `2026-03-04`. Both are
 * correct, which is the entire point of making the caller choose.
 */
export function parseStatementDate(raw: string, format: StatementDateFormat): string {
  const layout = DATE_LAYOUTS[format];
  if (!layout) {
    throw new StatementCsvError(
      `Unsupported date format ${JSON.stringify(format)}. ` +
        `Declare one of: ${SUPPORTED_DATE_FORMATS.join(", ")}.`,
    );
  }

  const text = raw.trim().replace(TRAILING_TIME, "").trim();
  const match = layout.pattern.exec(text);
  if (!match) {
    throw new StatementCsvError(
      `${JSON.stringify(raw)} is not a ${format} date. The import declared ${format}; ` +
        "fix the mapping or the file rather than letting the importer guess.",
    );
  }

  let year = 0;
  let month = 0;
  let day = 0;
  layout.order.forEach((part, index) => {
    const value = match[index + 1];
    if (part === "Y") year = Number(value);
    else if (part === "M") month = Number(value);
    else if (part === "D") day = Number(value);
    else {
      const resolved = MONTH_ABBREVIATIONS[value.toLowerCase()];
      if (!resolved) {
        throw new StatementCsvError(`${JSON.stringify(value)} is not a month abbreviation`);
      }
      month = resolved;
    }
  });

  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  try {
    return assertIsoDate(iso);
  } catch (error) {
    if (error instanceof FiscalCalendarError) {
      throw new StatementCsvError(
        `${JSON.stringify(raw)} read as ${format} gives ${iso}, which is not a real calendar date`,
      );
    }
    throw error;
  }
}
