export function buildCsv(
  headers: string[],
  rows: (string | number | null | undefined)[][],
): string {
  const escapeCell = (cell: string | number | null | undefined): string => {
    const str = cell === null || cell === undefined ? "" : String(cell);
    if (str.includes(",") || str.includes("\n") || str.includes('"')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const allRows = [headers, ...rows];
  return allRows.map((row) => row.map(escapeCell).join(",")).join("\n");
}
