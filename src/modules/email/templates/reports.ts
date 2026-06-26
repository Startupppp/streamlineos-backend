import { getEmailTemplate, escapeHtml } from "./base";

export function getWeeklyAttendanceReportTemplate(
  weekRange: string,
  orgName: string,
  rows: { department: string; name: string; totalHours: string; autoCheckoutDays: number; overtimeDays: number; daysPresent: number }[]
): string {
  const sOrgName = escapeHtml(orgName);
  const tableRows = rows
    .map(
      (r) => `
      <tr>
        <td style="border: 1px solid #d1d5db; padding: 8px 12px; color: #6b7280; font-size: 13px;">${escapeHtml(r.department)}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px 12px; color: #374151;">${escapeHtml(r.name)}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: center; color: #111827;">${r.daysPresent}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: center; color: #111827;">${escapeHtml(r.totalHours)}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: center; color: #111827;">${r.overtimeDays}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: center; color: ${r.autoCheckoutDays > 0 ? '#dc2626' : '#111827'};">${r.autoCheckoutDays}</td>
      </tr>`
    )
    .join("");

  const content = `
    <h2 class="email-title">Attendance Report</h2>
    <p class="email-text">
      Here is the attendance summary for <strong>${sOrgName}</strong> for the period <strong>${weekRange}</strong>.
    </p>

    <table style="width: 100%; border-collapse: collapse; margin: 24px 0; font-size: 14px;">
      <thead>
        <tr style="background-color: #f3f4f6;">
          <th style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; font-weight: 600; color: #111827;">Department</th>
          <th style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; font-weight: 600; color: #111827;">Employee</th>
          <th style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: center; font-weight: 600; color: #111827;">Days Present</th>
          <th style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: center; font-weight: 600; color: #111827;">Total Hours</th>
          <th style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: center; font-weight: 600; color: #111827;">Overtime Days</th>
          <th style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: center; font-weight: 600; color: #111827;">Auto-Checkout</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>

    <div class="divider"></div>

    <p class="email-text" style="font-size: 14px; color: #64748b;">
      This report includes all employees with at least one attendance record in the selected period, sorted by department. Review full details in the HR portal.
    </p>
  `;

  return getEmailTemplate({
    title: `Attendance Report - ${weekRange}`,
    preheader: `Attendance summary for ${weekRange}`,
    content,
  });
}

export interface MonthlyExpenseReportRow {
  date: string;
  employeeName: string;
  category: string;
  amount: string;
  currency: string;
  status: string;
}

export function getMonthlyExpenseReportTemplate(
  monthLabel: string,
  orgName: string,
  rows: MonthlyExpenseReportRow[],
  summary: { totalAmount: string; totalCount: number; pendingCount: number; approvedCount: number; paidCount: number; rejectedCount: number }
): string {
  const sOrgName = escapeHtml(orgName);
  const tableRows = rows
    .map(
      (r) => `
      <tr>
        <td style="border: 1px solid #d1d5db; padding: 8px 12px; color: #374151;">${escapeHtml(r.date)}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px 12px; color: #374151;">${escapeHtml(r.employeeName)}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px 12px; color: #374151;">${escapeHtml(r.category)}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: right; color: #111827;">${r.currency === "INR" ? "₹" : ""}${escapeHtml(r.amount)}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: center; color: #111827;">${escapeHtml(r.status)}</td>
      </tr>`
    )
    .join("");

  const content = `
    <h2 class="email-title">Monthly Expense Report</h2>
    <p class="email-text">
      Here is the expense summary for <strong>${sOrgName}</strong> for <strong>${monthLabel}</strong>.
    </p>

    <table style="width: 100%; border-collapse: collapse; margin: 24px 0; font-size: 14px;">
      <thead>
        <tr style="background-color: #f3f4f6;">
          <th style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; font-weight: 600; color: #111827;">Date</th>
          <th style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; font-weight: 600; color: #111827;">Employee</th>
          <th style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; font-weight: 600; color: #111827;">Category</th>
          <th style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: right; font-weight: 600; color: #111827;">Amount</th>
          <th style="border: 1px solid #d1d5db; padding: 8px 12px; text-align: center; font-weight: 600; color: #111827;">Status</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>

    <div style="background-color: #f8fafc; border-radius: 8px; padding: 16px; margin: 24px 0;">
      <p class="email-text" style="margin: 0 0 8px 0;"><strong>Summary</strong></p>
      <p class="email-text" style="margin: 0; font-size: 14px;">Total amount: <strong>₹${escapeHtml(summary.totalAmount)}</strong> &nbsp;|&nbsp; Total expenses: <strong>${summary.totalCount}</strong> &nbsp;|&nbsp; Pending: ${summary.pendingCount} &nbsp;|&nbsp; Approved: ${summary.approvedCount} &nbsp;|&nbsp; Paid: ${summary.paidCount} &nbsp;|&nbsp; Rejected: ${summary.rejectedCount}</p>
    </div>

    <div class="divider"></div>

    <p class="email-text" style="font-size: 14px; color: #64748b;">
      This is an automated monthly report. Review expense details in the HR portal.
    </p>
  `;

  return getEmailTemplate({
    title: `Monthly Expense Report - ${monthLabel}`,
    preheader: `Expense summary for ${monthLabel}`,
    content,
  });
}
