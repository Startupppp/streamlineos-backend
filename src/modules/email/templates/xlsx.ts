import ExcelJS from "exceljs";
import type { MonthlyExpenseReportRow } from "./reports";

export interface MonthlyExpenseReportSummary {
  totalAmount: string;
  totalCount: number;
  pendingCount: number;
  approvedCount: number;
  paidCount: number;
  rejectedCount: number;
}

export async function generateMonthlyExpenseReportXlsx(
  monthLabel: string,
  orgName: string,
  rows: MonthlyExpenseReportRow[],
  summary: MonthlyExpenseReportSummary
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const worksheet = workbook.addWorksheet("Expenses");
  worksheet.columns = [
    { header: "Date", width: 14 },
    { header: "Employee", width: 22 },
    { header: "Category", width: 18 },
    { header: "Amount", width: 14 },
    { header: "Status", width: 12 },
  ];
  for (const r of rows) {
    worksheet.addRow([
      r.date,
      r.employeeName,
      r.category,
      r.currency === "INR" ? `₹ ${r.amount}` : r.amount,
      r.status,
    ]);
  }

  const summarySheet = workbook.addWorksheet("Summary");
  summarySheet.columns = [{ width: 18 }, { width: 16 }];
  summarySheet.addRow(["Summary"]);
  summarySheet.addRow(["Total amount", `₹ ${summary.totalAmount}`]);
  summarySheet.addRow(["Total expenses", summary.totalCount]);
  summarySheet.addRow(["Pending", summary.pendingCount]);
  summarySheet.addRow(["Approved", summary.approvedCount]);
  summarySheet.addRow(["Paid", summary.paidCount]);
  summarySheet.addRow(["Rejected", summary.rejectedCount]);

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
