const CSV_ROW_CAP = 10_000;

export function buildCsv(headers: string[], rows: unknown[][]): string {
  const capped = rows.length > CSV_ROW_CAP ? rows.slice(0, CSV_ROW_CAP) : rows;
  const lines = [headers, ...capped];
  return lines
    .map((row) =>
      row.map((val) => `"${String(val ?? "").replace(/"/g, '""')}"`).join(","),
    )
    .join("\n");
}
