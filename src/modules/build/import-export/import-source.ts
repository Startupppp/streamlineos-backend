import { IMPORT_MAX_ROWS, IMPORT_MAX_CONTENT_BYTES } from "./import-export.constants";
import { isBlankCsvRow, parseCsvRows } from "./csv-source";

export type ImportFormat = "csv" | "json";

interface SourceRow {
  rowNumber: number;
  values: Record<string, unknown>;
}

interface SourceRowError {
  rowNumber: number;
  field: string | null;
  message: string;
}

export interface ParsedSource {
  format: ImportFormat;
  rows: SourceRow[];
  rowErrors: SourceRowError[];
  fileError: string | null;
}

const IMPORT_IGNORED_COLUMNS: readonly string[] = [
  "id",
  "ticketNumber",
  "ticketKey",
  "projectId",
  "orgId",
  "createdAt",
  "updatedAt",
];

const IGNORED = new Set(IMPORT_IGNORED_COLUMNS.map((name) => name.toLowerCase()));

function rejected(format: ImportFormat, message: string): ParsedSource {
  return { format, rows: [], rowErrors: [], fileError: message };
}

function withoutIgnoredColumns(values: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (IGNORED.has(key.toLowerCase())) continue;
    kept[key] = value;
  }
  return kept;
}

function parseCsvSource(text: string): ParsedSource {
  const grid = parseCsvRows(text).filter((row) => !isBlankCsvRow(row));
  const header = grid[0];
  if (!header) return rejected("csv", "The file has no header row");

  const columns = header.map((name) => name.trim());
  if (columns.some((name) => name === ""))
    return rejected("csv", "The header row has an unnamed column");

  const seen = new Set<string>();
  for (const name of columns) {
    const key = name.toLowerCase();
    if (seen.has(key)) return rejected("csv", `The header row repeats the column "${name}"`);
    seen.add(key);
  }

  const dataRows = grid.slice(1);
  if (dataRows.length > IMPORT_MAX_ROWS)
    return rejected("csv", `The file has ${dataRows.length} rows; the limit is ${IMPORT_MAX_ROWS}`);

  const rows: SourceRow[] = [];
  const rowErrors: SourceRowError[] = [];

  dataRows.forEach((cells, index) => {
    const rowNumber = index + 2;
    if (cells.length !== columns.length) {
      rowErrors.push({
        rowNumber,
        field: null,
        message: `Expected ${columns.length} columns but found ${cells.length}`,
      });
      return;
    }
    const values: Record<string, unknown> = {};
    columns.forEach((name, column) => {
      values[name] = cells[column];
    });
    rows.push({ rowNumber, values: withoutIgnoredColumns(values) });
  });

  return { format: "csv", rows, rowErrors, fileError: null };
}

function parseJsonSource(text: string): ParsedSource {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return rejected("json", "The file is not valid JSON");
  }

  if (!Array.isArray(payload)) return rejected("json", "The file must contain an array of rows");
  if (payload.length > IMPORT_MAX_ROWS)
    return rejected("json", `The file has ${payload.length} rows; the limit is ${IMPORT_MAX_ROWS}`);

  const rows: SourceRow[] = [];
  const rowErrors: SourceRowError[] = [];

  payload.forEach((entry, index) => {
    const rowNumber = index + 1;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      rowErrors.push({ rowNumber, field: null, message: "Expected an object" });
      return;
    }
    rows.push({
      rowNumber,
      values: withoutIgnoredColumns(entry as Record<string, unknown>),
    });
  });

  return { format: "json", rows, rowErrors, fileError: null };
}

export function parseImportSource(format: ImportFormat, text: string): ParsedSource {
  if (Buffer.byteLength(text, "utf8") > IMPORT_MAX_CONTENT_BYTES)
    return rejected(format, `The file is larger than ${IMPORT_MAX_CONTENT_BYTES} bytes`);
  if (text.trim() === "") return rejected(format, "The file is empty");
  return format === "csv" ? parseCsvSource(text) : parseJsonSource(text);
}
