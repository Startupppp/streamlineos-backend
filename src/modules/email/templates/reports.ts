import { EMAIL_THEME } from "../branding";
import { getEmailTemplate, escapeHtml } from "./base";
import { renderCallout } from "./components";

export interface MonthlyExpenseReportRow {
  date: string;
  employeeName: string;
  category: string;
  amount: string;
  currency: string;
  status: string;
}

export function getAttendanceReportTemplate(
  dateRange: string,
  orgName: string,
  rows: { department: string; name: string; totalHours: string; autoCheckoutDays: number; overtimeDays: number; daysPresent: number }[]
): string {
  const sOrgName = escapeHtml(orgName);
  const sDateRange = escapeHtml(dateRange);
  const tableRows = rows
    .map(
      (r) => `
      <tr>
        <td style="border:1px solid #e2e8f0;padding:8px 12px;color:#4A5568;font-size:13px;">${escapeHtml(r.department)}</td>
        <td style="border:1px solid #e2e8f0;padding:8px 12px;color:#0b1220;">${escapeHtml(r.name)}</td>
        <td style="border:1px solid #e2e8f0;padding:8px 12px;text-align:center;color:#0b1220;">${r.daysPresent}</td>
        <td style="border:1px solid #e2e8f0;padding:8px 12px;text-align:center;color:#0b1220;">${escapeHtml(r.totalHours)}</td>
        <td style="border:1px solid #e2e8f0;padding:8px 12px;text-align:center;color:#0b1220;">${r.overtimeDays}</td>
        <td style="border:1px solid #e2e8f0;padding:8px 12px;text-align:center;color:${r.autoCheckoutDays > 0 ? "#dc2626" : "#0b1220"};">${r.autoCheckoutDays}</td>
      </tr>`
    )
    .join("");

  const content = `
    <p class="email-text">Attendance for <strong>${sOrgName}</strong> â€” <strong>${sDateRange}</strong>.</p>

    <table style="width:100%;border-collapse:collapse;margin:24px 0;font-size:14px;">
      <thead>
        <tr style="background-color:#F7F9FF;">
          <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:left;font-weight:600;color:#0b1220;">Department</th>
          <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:left;font-weight:600;color:#0b1220;">Employee</th>
          <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:center;font-weight:600;color:#0b1220;">Days present</th>
          <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:center;font-weight:600;color:#0b1220;">Total hours</th>
          <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:center;font-weight:600;color:#0b1220;">Overtime days</th>
          <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:center;font-weight:600;color:#0b1220;">Auto-checkout</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
  `;

  return getEmailTemplate({
    title: `Attendance report â€” ${sDateRange}`,
    preheader: `Attendance summary for ${sOrgName} â€” ${sDateRange}`,
    content,
  });
}

export function getMonthlyExpenseReportTemplate(
  monthLabel: string,
  orgName: string,
  rows: MonthlyExpenseReportRow[],
  summary: { totalAmount: string; totalCount: number; pendingCount: number; approvedCount: number; paidCount: number; rejectedCount: number }
): string {
  const sOrgName = escapeHtml(orgName);
  const sMonthLabel = escapeHtml(monthLabel);
  const tableRows = rows
    .map(
      (r) => `
      <tr>
        <td style="border:1px solid #e2e8f0;padding:8px 12px;color:#4A5568;">${escapeHtml(r.date)}</td>
        <td style="border:1px solid #e2e8f0;padding:8px 12px;color:#0b1220;">${escapeHtml(r.employeeName)}</td>
        <td style="border:1px solid #e2e8f0;padding:8px 12px;color:#4A5568;">${escapeHtml(r.category)}</td>
        <td style="border:1px solid #e2e8f0;padding:8px 12px;text-align:right;color:#1e40af;">${r.currency === "INR" ? "&#8377;" : ""}${escapeHtml(r.amount)}</td>
        <td style="border:1px solid #e2e8f0;padding:8px 12px;text-align:center;color:#0b1220;">${escapeHtml(r.status)}</td>
      </tr>`
    )
    .join("");

  const content = `
    <p class="email-text">Expenses for <strong>${sOrgName}</strong> â€” <strong>${sMonthLabel}</strong>.</p>

    <table style="width:100%;border-collapse:collapse;margin:24px 0;font-size:14px;">
      <thead>
        <tr style="background-color:#F7F9FF;">
          <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:left;font-weight:600;color:#0b1220;">Date</th>
          <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:left;font-weight:600;color:#0b1220;">Employee</th>
          <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:left;font-weight:600;color:#0b1220;">Category</th>
          <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:right;font-weight:600;color:#0b1220;">Amount</th>
          <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:center;font-weight:600;color:#0b1220;">Status</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>

    <div style="background-color:#F7F9FF;border-left:4px solid #3b82f6;padding:16px 20px;border-radius:0 8px 8px 0;margin:24px 0;">
      <p style="font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;color:#0b1220;margin:0 0 4px 0;font-weight:600;">Summary</p>
      <p style="font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;color:#4A5568;margin:0;">Total: <strong style="color:#1e40af;">&#8377;${escapeHtml(summary.totalAmount)}</strong> &nbsp;&middot;&nbsp; ${summary.totalCount} expense${summary.totalCount !== 1 ? "s" : ""} &nbsp;&middot;&nbsp; Pending: ${summary.pendingCount} &nbsp;&middot;&nbsp; Approved: ${summary.approvedCount} &nbsp;&middot;&nbsp; Paid: ${summary.paidCount} &nbsp;&middot;&nbsp; Rejected: ${summary.rejectedCount}</p>
    </div>
  `;

  return getEmailTemplate({
    title: `Expense report â€” ${sMonthLabel}`,
    preheader: `Expense summary for ${sOrgName} â€” ${sMonthLabel}`,
    content,
  });
}

export interface WeeklyRecapData {
  orgName: string;
  weekRange: string;
  totalEmployees: number;
  newLeads: number;
  convertedLeads: number;
  totalActivities: number;
  openTickets: number;
  closedTickets: number;
  pendingLeaves: number;
  topPerformers: Array<{ name: string; score: number }>;
  pipelineSummary: Array<{ status: string; count: number }>;
  aiNarrative: string;
}

export function getWeeklyRecapEmailTemplate(data: WeeklyRecapData): string {
  const sOrgName = escapeHtml(data.orgName);
  const sWeekRange = escapeHtml(data.weekRange);

  const narrativeBlock = data.aiNarrative
    ? renderCallout(escapeHtml(data.aiNarrative).replace(/\n\n/g, "<br><br>").replace(/\n/g, " "), "info")
    : "";

  const kpiRows = `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0;width:100%;">
      <tr>
        <td class="email-stack-col" width="50%" style="padding:0 6px 12px 0;width:50%;">
          <div style="background:#eff6ff;border-radius:8px;padding:16px;text-align:center;">
            <p style="margin:0;font-size:28px;font-weight:700;color:#1e40af;font-family:${EMAIL_THEME.font};">${data.newLeads}</p>
            <p style="margin:4px 0 0;font-size:13px;color:#4A5568;font-family:${EMAIL_THEME.font};">New leads</p>
          </div>
        </td>
        <td class="email-stack-col" width="50%" style="padding:0 0 12px 6px;width:50%;">
          <div style="background:#f0fdf4;border-radius:8px;padding:16px;text-align:center;">
            <p style="margin:0;font-size:28px;font-weight:700;color:#166534;font-family:${EMAIL_THEME.font};">${data.convertedLeads}</p>
            <p style="margin:4px 0 0;font-size:13px;color:#4A5568;font-family:${EMAIL_THEME.font};">Conversions</p>
          </div>
        </td>
      </tr>
      <tr>
        <td class="email-stack-col" width="50%" style="padding:0 6px 0 0;width:50%;">
          <div style="background:#fefce8;border-radius:8px;padding:16px;text-align:center;">
            <p style="margin:0;font-size:28px;font-weight:700;color:#92400e;font-family:${EMAIL_THEME.font};">${data.totalActivities}</p>
            <p style="margin:4px 0 0;font-size:13px;color:#4A5568;font-family:${EMAIL_THEME.font};">Activities logged</p>
          </div>
        </td>
        <td class="email-stack-col" width="50%" style="padding:0 0 0 6px;width:50%;">
          <div style="background:#eff6ff;border-radius:8px;padding:16px;text-align:center;">
            <p style="margin:0;font-size:28px;font-weight:700;color:#1e40af;font-family:${EMAIL_THEME.font};">${data.closedTickets}</p>
            <p style="margin:4px 0 0;font-size:13px;color:#475569;font-family:${EMAIL_THEME.font};">Tickets closed</p>
          </div>
        </td>
      </tr>
    </table>`;

  const statsTable = `
    <table style="width:100%;border-collapse:collapse;margin:20px 0;">
      <tr><td style="padding:8px 0;font-size:13px;color:#4A5568;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;border-bottom:1px solid #f1f5f9;">Total employees</td><td style="text-align:right;font-weight:600;color:#0b1220;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;border-bottom:1px solid #f1f5f9;">${data.totalEmployees}</td></tr>
      <tr><td style="padding:8px 0;font-size:13px;color:#4A5568;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;border-bottom:1px solid #f1f5f9;">Open tickets</td><td style="text-align:right;font-weight:600;color:#0b1220;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;border-bottom:1px solid #f1f5f9;">${data.openTickets}</td></tr>
      <tr><td style="padding:8px 0;font-size:13px;color:#4A5568;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">Pending leave requests</td><td style="text-align:right;font-weight:600;color:#0b1220;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">${data.pendingLeaves}</td></tr>
    </table>`;

  const topPerformersSection = data.topPerformers.length > 0
    ? `<p style="font-size:14px;font-weight:600;color:#0b1220;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;margin:24px 0 8px 0;border-bottom:2px solid #e2e8f0;padding-bottom:6px;">Sales leaderboard</p>
       <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
         <thead><tr style="background-color:#f8fafc;">
           <th style="padding:8px 12px;text-align:left;font-size:12px;color:#4A5568;font-weight:600;">Rank</th>
           <th style="padding:8px 12px;text-align:left;font-size:12px;color:#4A5568;font-weight:600;">Name</th>
           <th style="padding:8px 12px;text-align:right;font-size:12px;color:#4A5568;font-weight:600;">Score</th>
         </tr></thead>
         <tbody>${data.topPerformers.slice(0, 5).map((p, i) =>
           `<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">${i === 0 ? "1st" : i === 1 ? "2nd" : i === 2 ? "3rd" : `#${i + 1}`}</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">${escapeHtml(p.name)}</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:600;font-size:13px;">${p.score} pts</td></tr>`
         ).join("")}</tbody>
       </table>`
    : "";

  const pipelineSection = data.pipelineSummary.length > 0
    ? `<p style="font-size:14px;font-weight:600;color:#0b1220;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;margin:24px 0 8px 0;border-bottom:2px solid #e2e8f0;padding-bottom:6px;">Lead pipeline</p>
       <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
         <thead><tr style="background-color:#f8fafc;">
           <th style="padding:6px 12px;text-align:left;font-size:12px;color:#4A5568;font-weight:600;">Status</th>
           <th style="padding:6px 12px;text-align:right;font-size:12px;color:#4A5568;font-weight:600;">Count</th>
         </tr></thead>
         <tbody>${data.pipelineSummary.map(s =>
           `<tr><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">${escapeHtml(s.status)}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:600;font-size:13px;">${s.count}</td></tr>`
         ).join("")}</tbody>
       </table>`
    : "";

  const content = `
    <p class="email-text">Your weekly overview for <strong>${sOrgName}</strong> â€” week of <strong>${sWeekRange}</strong>.</p>
    ${narrativeBlock}
    ${kpiRows}
    ${statsTable}
    ${topPerformersSection}
    ${pipelineSection}
  `;

  return getEmailTemplate({
    title: `Your week at ${sOrgName}`,
    preheader: `Weekly recap for ${sOrgName} â€” ${sWeekRange}: ${data.newLeads} new leads, ${data.convertedLeads} conversions.`,
    content,
  });
}
