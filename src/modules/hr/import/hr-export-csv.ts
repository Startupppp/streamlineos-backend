export interface EmployeeExportCsvRow {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  employeeId: string;
  designation: string;
  role: string;
  department: string;
  status: string;
}

/**
 * Ticket 07. First and last name are their own columns. Collapsing them into one
 * "Name" cell made the export the one surface where the two could not be told
 * apart, so a downstream mail merge or payroll import had to guess where the
 * given name ended — which is wrong for every multi-word and particled surname.
 * "Name" stays as the display name the product shows, so existing consumers of
 * the file keep working.
 */
export const EMPLOYEE_EXPORT_CSV_HEADER = [
  "Name",
  "First name",
  "Last name",
  "Email",
  "Employee ID",
  "Designation",
  "Role",
  "Department",
  "Status",
] as const;

function protectSpreadsheetCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string): string {
  const protectedValue = protectSpreadsheetCell(value);
  return `"${protectedValue.replace(/"/g, '""')}"`;
}

export function serializeEmployeeExportHeader(): string {
  return `\uFEFF${EMPLOYEE_EXPORT_CSV_HEADER.map(csvCell).join(",")}\r\n`;
}

export function serializeEmployeeExportRow(row: EmployeeExportCsvRow): string {
  return `${[
    row.name,
    row.firstName,
    row.lastName,
    row.email,
    row.employeeId,
    row.designation,
    row.role,
    row.department,
    row.status,
  ]
    .map(csvCell)
    .join(",")}\r\n`;
}
