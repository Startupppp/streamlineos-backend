export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records = parseRecords(text.trim());
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0] ?? [];
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < records.length; i++) {
    const values = records[i] ?? [];
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ""; });
    rows.push(row);
  }
  return { headers, rows };
}

function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let current = "";
  let inQuote = false;
  let fieldQuoted = false;
  const pushField = () => {
    fields.push(fieldQuoted ? current : current.trim());
    current = "";
    fieldQuoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { current += '"'; i++; }
        else { inQuote = false; }
      } else {
        current += ch;
      }
    } else if (ch === '"' && current === "") {
      inQuote = true;
      fieldQuoted = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      if (current.endsWith('\r')) current = current.slice(0, -1);
      pushField();
      records.push(fields);
      fields = [];
    } else {
      current += ch;
    }
  }
  pushField();
  if (fields.length > 1 || (fields[0] ?? "") !== "") records.push(fields);
  return records;
}

export function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const escapeField = (v: unknown): string => {
    let s = v == null ? "" : String(v);
    // Prevent CSV/formula injection: neutralize leading =, +, -, @ before a
    // spreadsheet app can interpret the cell as a formula.
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines: string[] = [headers.map(escapeField).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeField(row[h])).join(","));
  }
  return lines.join("\n");
}
