import { StatementCsvError } from "./statement-csv-error";

/**
 * RFC 4180 reader — quoted fields, doubled quotes, embedded delimiters and
 * newlines, CRLF or LF. Deliberately hand-written: a bank statement importer
 * should not drag a parsing dependency into the accounting kernel.
 */
export function parseCsv(content: string, delimiter = ","): string[][] {
  if (delimiter.length !== 1) {
    throw new StatementCsvError(`Delimiter must be a single character, got ${JSON.stringify(delimiter)}`);
  }

  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAnyCharacter = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.trim() === "") {
      // Only treat a quote as an opener at the start of a field, so a stray
      // quote mid-narration does not swallow the rest of the file.
      field = "";
      inQuotes = true;
      sawAnyCharacter = true;
      continue;
    }

    if (ch === delimiter) {
      row.push(field);
      field = "";
      sawAnyCharacter = true;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAnyCharacter = false;
      continue;
    }

    field += ch;
    sawAnyCharacter = true;
  }

  if (inQuotes) {
    throw new StatementCsvError("The file ends inside a quoted field — it is not valid CSV");
  }
  if (field !== "" || row.length > 0 || sawAnyCharacter) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
