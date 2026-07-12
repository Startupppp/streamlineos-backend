export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers, ...rows];
  return lines
    .map((row) =>
      row.map((val) => `"${String(val ?? "").replace(/"/g, '""')}"`).join(","),
    )
    .join("\n");
}
