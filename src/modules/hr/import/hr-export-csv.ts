export interface EmployeeExportCsvRow {
  name: string;
  email: string;
  employeeId: string;
  designation: string;
  role: string;
  department: string;
  status: string;
}

export const EMPLOYEE_EXPORT_CSV_HEADER = [
  "Name",
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
