const BYTE_ORDER_MARK = "\ufeff";

const NEEDS_QUOTING = /[",\r\n]/;

export function parseCsvRows(text: string): string[][] {
  const source = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let open = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (quoted) {
      if (char !== '"') {
        field += char;
        continue;
      }
      if (source[i + 1] === '"') {
        field += '"';
        i += 1;
        continue;
      }
      quoted = false;
      continue;
    }

    if (char === '"') {
      quoted = true;
      open = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      open = true;
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      open = false;
      continue;
    }

    field += char;
    open = true;
  }

  if (open || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export function isBlankCsvRow(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim() === "");
}

function escapeCsvValue(value: string): string {
  return NEEDS_QUOTING.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(escapeCsvValue).join(",")).join("\r\n");
}
