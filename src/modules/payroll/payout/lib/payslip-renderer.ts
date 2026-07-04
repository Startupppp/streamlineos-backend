import type { CalculationSnapshot, CalculationSnapshotLine, PayrollWorkerType } from "../../payroll.types";
import type { PayslipPdfData } from "../../../hr-payroll/lib/payslip-pdf";
import type { PayslipTemplateConfig } from "../dto/payout.schemas";
import { amountInWords } from "./amount-in-words";

export interface RendererEmployeeInfo {
  name: string;
  employeeId?: string;
  designation?: string;
  department?: string;
  joiningDate?: string;
  maskedAccount?: string;
  bankName?: string;
  ifsc?: string;
  pan?: string;
  pfUan?: string;
}

export interface RendererOrgInfo {
  name: string;
  address?: string;
}

export interface RenderParams {
  snapshot: CalculationSnapshot;
  employee: RendererEmployeeInfo;
  org: RendererOrgInfo;
  workerType: PayrollWorkerType;
  month: string;
  layout: "CLASSIC" | "MODERN" | "COMPLIANCE";
  config: PayslipTemplateConfig;
}

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function fmtMonthYear(month: string): string {
  const parts = month.split("-");
  const yr = parts[0] ?? "";
  const mo = parseInt(parts[1] ?? "1", 10);
  return `${MONTHS_LONG[mo - 1] ?? ""} ${yr}`.trim();
}

function fmtMoney(v: string, currency: string): string {
  const n = parseFloat(v) || 0;
  return currency === "INR"
    ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`
    : `${currency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

function byCategory(lines: CalculationSnapshotLine[], cat: string): CalculationSnapshotLine[] {
  return lines.filter(l => l.category === cat).sort((a, b) => a.sortOrder - b.sortOrder);
}

function isContr(workerType: PayrollWorkerType): boolean {
  return workerType === "CONTRACTOR";
}

function empBar(e: RendererEmployeeInfo, accent: string): string {
  return `<div style="background:${accent};color:#fff;padding:8px 20px;display:flex;gap:28px;flex-wrap:wrap;">
<div><div style="font-size:9px;opacity:.6;text-transform:uppercase;letter-spacing:.06em">Employee</div><div style="font-weight:600;font-size:12px;margin-top:2px">${e.name}</div></div>
<div><div style="font-size:9px;opacity:.6;text-transform:uppercase;letter-spacing:.06em">ID</div><div style="font-weight:600;font-size:12px;margin-top:2px">${e.employeeId ?? "—"}</div></div>
<div><div style="font-size:9px;opacity:.6;text-transform:uppercase;letter-spacing:.06em">Designation</div><div style="font-weight:600;font-size:12px;margin-top:2px">${e.designation ?? "—"}</div></div>
<div><div style="font-size:9px;opacity:.6;text-transform:uppercase;letter-spacing:.06em">Department</div><div style="font-weight:600;font-size:12px;margin-top:2px">${e.department ?? "—"}</div></div>
</div>`;
}

function netBar(snap: CalculationSnapshot, currency: string, accent: string, label: string): string {
  return `<div style="background:${accent};color:#fff;padding:10px 20px;display:flex;justify-content:space-between;align-items:center;">
<span style="font-size:13px;font-weight:700">${label}</span>
<span style="font-size:18px;font-weight:800;color:#bd882c">${fmtMoney(snap.totals.net, currency)}</span>
</div>
<div style="background:#f5f7ff;padding:6px 20px;font-size:11px;font-style:italic;border-bottom:2px solid ${accent}">
In words: <strong>${amountInWords(snap.totals.net, currency)}</strong>
</div>`;
}

function bankSection(e: RendererEmployeeInfo, accent: string): string {
  return `<div style="display:grid;grid-template-columns:1fr 1fr;border-top:1px solid #ddd;">
<div style="padding:12px 20px;border-right:1px solid #ddd;">
<div style="font-size:10px;text-transform:uppercase;color:${accent};border-bottom:1px solid #e0e8ff;padding-bottom:4px;margin-bottom:8px;font-weight:700">Bank Details</div>
<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px"><span>Bank</span><span>${e.bankName ?? "—"}</span></div>
<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px"><span>Account</span><span>${e.maskedAccount ?? "—"}</span></div>
<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px"><span>IFSC</span><span>${e.ifsc ?? "—"}</span></div>
</div>
<div style="padding:12px 20px;">
<div style="font-size:10px;text-transform:uppercase;color:${accent};border-bottom:1px solid #e0e8ff;padding-bottom:4px;margin-bottom:8px;font-weight:700">Authorisation</div>
<p style="font-size:11px;color:#555;margin-bottom:16px">This is a system-generated document and does not require a physical signature.</p>
<div style="border-top:1px solid #aaa;padding-top:5px;font-size:10px;color:#666;text-align:center">Authorised Signatory</div>
</div>
</div>`;
}

function footer(org: RendererOrgInfo, monthLabel: string): string {
  return `<div style="background:#f9f9f9;border-top:1px solid #e0e0e0;padding:7px 20px;font-size:10px;color:#888;text-align:center">${org.name} &nbsp;·&nbsp; ${monthLabel} &nbsp;·&nbsp; Confidential — For Recipient Use Only</div>`;
}

function renderClassic(p: RenderParams): string {
  const { snapshot, employee, org, workerType, month, config } = p;
  const { accent } = config;
  const { currency } = snapshot;
  const monthLabel = fmtMonthYear(month);
  const title = isContr(workerType) ? "Payment Advice" : "Salary Slip";
  const contractor = isContr(workerType);
  const earnings = byCategory(snapshot.lines, "EARNING");
  const deductions = contractor ? [] : [
    ...byCategory(snapshot.lines, "DEDUCTION"),
    ...byCategory(snapshot.lines, "TAX"),
  ];
  const employer = (!contractor && config.showEmployerContributions)
    ? byCategory(snapshot.lines, "EMPLOYER_CONTRIBUTION") : [];
  const maxRows = Math.max(earnings.length, deductions.length);

  let tableRows = "";
  for (let i = 0; i < maxRows; i++) {
    const e = earnings[i];
    const d = deductions[i];
    tableRows += `<tr>
<td style="padding:5px 10px;border:1px solid #eef0f6;font-size:12px">${e?.name ?? ""}</td>
<td style="padding:5px 10px;border:1px solid #eef0f6;font-size:12px;text-align:right">${e ? fmtMoney(e.amount, currency) : ""}</td>
${contractor ? "" : `<td style="padding:5px 10px;border:1px solid #eef0f6;font-size:12px;color:#b91c1c">${d?.name ?? ""}</td>
<td style="padding:5px 10px;border:1px solid #eef0f6;font-size:12px;text-align:right;color:#b91c1c">${d ? fmtMoney(d.amount, currency) : ""}</td>`}
</tr>`;
  }

  if (employer.length > 0) {
    tableRows += `<tr><td colspan="${contractor ? 2 : 4}" style="padding:6px 10px;background:#f5f7ff;font-size:10px;text-transform:uppercase;color:${accent};font-weight:700">Employer Contributions</td></tr>`;
    for (const l of employer) {
      tableRows += `<tr>
<td style="padding:5px 10px;border:1px solid #eef0f6;font-size:12px">${l.name}</td>
<td style="padding:5px 10px;border:1px solid #eef0f6;font-size:12px;text-align:right">${fmtMoney(l.amount, currency)}</td>
${contractor ? "" : "<td style=\"padding:5px 10px;border:1px solid #eef0f6\"></td><td style=\"padding:5px 10px;border:1px solid #eef0f6\"></td>"}
</tr>`;
    }
  }

  const subtotalCols = contractor
    ? `<td style="padding:6px 10px;font-weight:600;background:#f5f7ff;font-size:12px">Gross</td>
<td style="padding:6px 10px;font-weight:600;background:#f5f7ff;font-size:12px;text-align:right">${fmtMoney(snapshot.totals.gross, currency)}</td>`
    : `<td style="padding:6px 10px;font-weight:600;background:#f5f7ff;font-size:12px">Gross Earnings</td>
<td style="padding:6px 10px;font-weight:600;background:#f5f7ff;font-size:12px;text-align:right">${fmtMoney(snapshot.totals.gross, currency)}</td>
<td style="padding:6px 10px;font-weight:600;background:#f5f7ff;font-size:12px">Total Deductions</td>
<td style="padding:6px 10px;font-weight:600;background:#f5f7ff;font-size:12px;text-align:right;color:#b91c1c">${fmtMoney(snapshot.totals.deductions, currency)}</td>`;

  const thStyle = `style="font-size:10px;text-transform:uppercase;padding:6px 10px;border:1px solid #dde3f0;background:#f5f7ff;color:${accent};text-align:left"`;
  const thR = `style="font-size:10px;text-transform:uppercase;padding:6px 10px;border:1px solid #dde3f0;background:#f5f7ff;color:${accent};text-align:right"`;
  const headerCols = contractor
    ? `<th ${thStyle}>Earnings</th><th ${thR}>Amount</th>`
    : `<th ${thStyle}>Earnings</th><th ${thR}>Amount</th><th ${thStyle}>Deductions</th><th ${thR}>Amount</th>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>${title} – ${employee.name} – ${monthLabel}</title></head>
<body style="margin:0;font-family:Arial,'Segoe UI',sans-serif;background:#f0f0f0;color:#111;font-size:13px;">
<div style="max-width:800px;margin:20px auto;background:#fff;border:1px solid #ccc;">
<div style="display:flex;align-items:center;padding:14px 20px;border-bottom:3px solid ${accent};gap:14px;">
<div style="flex:1"><h1 style="font-size:18px;color:${accent};font-weight:700;margin:0">${org.name}</h1>${org.address ? `<p style="font-size:11px;color:#555;margin:2px 0 0">${org.address}</p>` : ""}</div>
<div style="text-align:right"><h2 style="font-size:14px;font-weight:700;margin:0">${title}</h2><p style="font-size:11px;color:#555;margin:2px 0 0">${monthLabel}</p></div>
</div>
${empBar(employee, accent)}
<div style="display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #ddd;">
<div style="padding:12px 20px;border-right:1px solid #ddd;">
<div style="font-size:10px;text-transform:uppercase;color:${accent};border-bottom:1px solid #e0e8ff;padding-bottom:4px;margin-bottom:8px;font-weight:700">Employee Information</div>
<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px"><span>Date of Joining</span><span>${employee.joiningDate ?? "—"}</span></div>
<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px"><span>PAN</span><span>${employee.pan ?? "—"}</span></div>
${employee.pfUan ? `<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px"><span>PF UAN</span><span>${employee.pfUan}</span></div>` : ""}
</div>
<div style="padding:12px 20px;">
<div style="font-size:10px;text-transform:uppercase;color:${accent};border-bottom:1px solid #e0e8ff;padding-bottom:4px;margin-bottom:8px;font-weight:700">Payroll Information</div>
<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px"><span>Pay Period</span><span>${monthLabel}</span></div>
<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px"><span>Scheduled Days</span><span>${snapshot.scheduledDays}</span></div>
<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px"><span>Paid Days</span><span>${snapshot.paidDays}</span></div>
${parseFloat(snapshot.lopDays) > 0 ? `<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px"><span>LOP Days</span><span style="color:#b91c1c">${snapshot.lopDays}</span></div>` : ""}
</div>
</div>
<div style="padding:0 20px 16px">
<table style="width:100%;border-collapse:collapse">
<thead><tr>${headerCols}</tr></thead>
<tbody>${tableRows}<tr style="border-top:2px solid #dde3f0">${subtotalCols}</tr></tbody>
</table>
</div>
${netBar(snapshot, currency, accent, contractor ? "Net Payment Payable" : "Net Salary Payable")}
${bankSection(employee, accent)}
${footer(org, monthLabel)}
</div></body></html>`;
}

function renderModern(p: RenderParams): string {
  const { snapshot, employee, org, workerType, month, config } = p;
  const { accent } = config;
  const { currency } = snapshot;
  const monthLabel = fmtMonthYear(month);
  const title = isContr(workerType) ? "Payment Advice" : "Salary Slip";
  const contractor = isContr(workerType);
  const earnings = byCategory(snapshot.lines, "EARNING");
  const deductions = contractor ? [] : [
    ...byCategory(snapshot.lines, "DEDUCTION"),
    ...byCategory(snapshot.lines, "TAX"),
  ];
  const employer = (!contractor && config.showEmployerContributions)
    ? byCategory(snapshot.lines, "EMPLOYER_CONTRIBUTION") : [];

  const lineRow = (name: string, amt: string, red = false): string =>
    `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:13px">
<span style="color:#444">${name}</span><span style="font-weight:600${red ? ";color:#b91c1c" : ""}">${amt}</span>
</div>`;

  const sectionHead = (label: string): string =>
    `<div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${accent};font-weight:700;margin:18px 0 6px">${label}</div>`;

  let body = sectionHead("Earnings");
  for (const l of earnings) body += lineRow(l.name, fmtMoney(l.amount, currency));
  body += lineRow("Gross Earnings", fmtMoney(snapshot.totals.gross, currency));

  if (deductions.length > 0) {
    body += sectionHead("Deductions");
    for (const l of deductions) body += lineRow(l.name, fmtMoney(l.amount, currency), true);
    body += lineRow("Total Deductions", fmtMoney(snapshot.totals.deductions, currency), true);
  }

  if (employer.length > 0) {
    body += sectionHead("Employer Contributions");
    for (const l of employer) body += lineRow(l.name, fmtMoney(l.amount, currency));
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>${title} – ${employee.name} – ${monthLabel}</title></head>
<body style="margin:0;font-family:'Segoe UI',Arial,sans-serif;background:#fafafa;color:#111;">
<div style="max-width:680px;margin:24px auto;background:#fff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.08);overflow:hidden">
<div style="background:${accent};color:#fff;padding:24px 28px;">
<div style="font-size:22px;font-weight:800;margin-bottom:2px">${org.name}</div>
${org.address ? `<div style="font-size:12px;opacity:.7">${org.address}</div>` : ""}
<div style="margin-top:16px;font-size:14px;opacity:.8">${title} &nbsp;·&nbsp; ${monthLabel}</div>
</div>
${empBar(employee, accent)}
<div style="padding:20px 28px">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;background:#f8f9ff;border-radius:8px;padding:14px;margin-bottom:4px">
<div style="font-size:11px;color:#555">Date of Joining: <strong>${employee.joiningDate ?? "—"}</strong></div>
<div style="font-size:11px;color:#555">PAN: <strong>${employee.pan ?? "—"}</strong></div>
<div style="font-size:11px;color:#555">Paid Days: <strong>${snapshot.paidDays} / ${snapshot.scheduledDays}</strong></div>
${employee.pfUan ? `<div style="font-size:11px;color:#555">PF UAN: <strong>${employee.pfUan}</strong></div>` : ""}
</div>
${body}
</div>
${netBar(snapshot, currency, accent, contractor ? "Net Payment Payable" : "Net Salary Payable")}
${bankSection(employee, accent)}
${footer(org, monthLabel)}
</div></body></html>`;
}

function renderCompliance(p: RenderParams): string {
  const { snapshot, employee, org, workerType, month, config } = p;
  const { accent } = config;
  const { currency } = snapshot;
  const monthLabel = fmtMonthYear(month);
  const title = isContr(workerType) ? "Payment Advice" : "Salary Slip";
  const contractor = isContr(workerType);

  const visibleLines = contractor
    ? snapshot.lines.filter(l => l.category === "EARNING")
    : snapshot.lines;
  const sorted = [...visibleLines].sort((a, b) => {
    const catOrder: Record<string, number> = { EARNING: 0, DEDUCTION: 1, TAX: 2, EMPLOYER_CONTRIBUTION: 3, REIMBURSEMENT: 4, ADJUSTMENT: 5 };
    const cmp = (catOrder[a.category] ?? 9) - (catOrder[b.category] ?? 9);
    return cmp !== 0 ? cmp : a.sortOrder - b.sortOrder;
  });

  const thS = `style="padding:6px 8px;border:1px solid #dde3f0;background:#f5f7ff;font-size:10px;text-transform:uppercase;color:${accent};text-align:left"`;
  const tdS = `style="padding:5px 8px;border:1px solid #eef0f6;font-size:11px"`;
  const tdR = `style="padding:5px 8px;border:1px solid #eef0f6;font-size:11px;text-align:right"`;

  let rows = "";
  for (const l of sorted) {
    const isNeg = l.category === "DEDUCTION" || l.category === "TAX";
    rows += `<tr>
<td ${tdS}>${l.code}</td>
<td ${tdS}>${l.name}</td>
<td ${tdS}>${l.category}</td>
<td ${tdS}>${l.calcMethod}</td>
<td ${tdS}>${l.taxable ? "Yes" : "No"}</td>
<td ${tdR} style="padding:5px 8px;border:1px solid #eef0f6;font-size:11px;text-align:right${isNeg ? ";color:#b91c1c" : ""}">${fmtMoney(l.amount, currency)}</td>
</tr>`;
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>${title} – ${employee.name} – ${monthLabel}</title></head>
<body style="margin:0;font-family:Arial,monospace,sans-serif;background:#f0f0f0;color:#111;font-size:12px;">
<div style="max-width:900px;margin:20px auto;background:#fff;border:1px solid #ccc;">
<div style="display:flex;align-items:center;padding:12px 20px;border-bottom:3px solid ${accent};gap:14px;">
<div style="flex:1"><strong style="font-size:16px;color:${accent}">${org.name}</strong>${org.address ? ` &nbsp;·&nbsp; <span style="font-size:11px;color:#555">${org.address}</span>` : ""}</div>
<div style="text-align:right"><strong>${title}</strong> &nbsp;·&nbsp; <span style="color:#555">${monthLabel}</span></div>
</div>
<div style="background:${accent};color:#fff;padding:6px 20px;display:flex;gap:24px;flex-wrap:wrap;font-size:11px">
<span>Employee: <strong>${employee.name}</strong></span>
<span>ID: <strong>${employee.employeeId ?? "—"}</strong></span>
<span>Designation: <strong>${employee.designation ?? "—"}</strong></span>
<span>Dept: <strong>${employee.department ?? "—"}</strong></span>
<span>Period: <strong>${monthLabel}</strong></span>
<span>Paid Days: <strong>${snapshot.paidDays}/${snapshot.scheduledDays}</strong></span>
${parseFloat(snapshot.lopDays) > 0 ? `<span style="color:#ffaaaa">LOP: <strong>${snapshot.lopDays}</strong></span>` : ""}
</div>
<div style="padding:12px 20px">
<table style="width:100%;border-collapse:collapse">
<thead><tr>
<th ${thS}>Code</th><th ${thS}>Component</th><th ${thS}>Type</th><th ${thS}>Method</th><th ${thS}>Taxable</th><th style="padding:6px 8px;border:1px solid #dde3f0;background:#f5f7ff;font-size:10px;text-transform:uppercase;color:${accent};text-align:right">Amount</th>
</tr></thead>
<tbody>${rows}
<tr style="border-top:2px solid #dde3f0;background:#f5f7ff">
<td colspan="5" style="padding:6px 8px;font-weight:700;font-size:11px">Gross Earnings</td>
<td style="padding:6px 8px;font-weight:700;font-size:11px;text-align:right">${fmtMoney(snapshot.totals.gross, currency)}</td>
</tr>
${!contractor ? `<tr style="background:#fff5f5"><td colspan="5" style="padding:5px 8px;font-weight:700;font-size:11px">Total Deductions</td><td style="padding:5px 8px;font-weight:700;font-size:11px;text-align:right;color:#b91c1c">${fmtMoney(snapshot.totals.deductions, currency)}</td></tr>` : ""}
${!contractor && config.showEmployerContributions ? `<tr style="background:#f0fff4"><td colspan="5" style="padding:5px 8px;font-weight:700;font-size:11px">Employer Contributions</td><td style="padding:5px 8px;font-weight:700;font-size:11px;text-align:right">${fmtMoney(snapshot.totals.employerContributions, currency)}</td></tr>` : ""}
</tbody>
</table>
</div>
${netBar(snapshot, currency, accent, contractor ? "Net Payment Payable" : "Net Salary Payable")}
${bankSection(employee, accent)}
${footer(org, monthLabel)}
</div></body></html>`;
}

export function renderPayslipHtml(params: RenderParams): string {
  switch (params.layout) {
    case "CLASSIC": return renderClassic(params);
    case "MODERN": return renderModern(params);
    case "COMPLIANCE": return renderCompliance(params);
  }
}

export function buildPayslipPdfData(params: RenderParams): PayslipPdfData {
  const { snapshot, employee, org, month } = params;
  const { lines, totals, currency } = snapshot;

  const findLine = (code: string): CalculationSnapshotLine | undefined =>
    lines.find(l => l.code === code && l.category === "EARNING");

  const basicLine = findLine("BASIC");
  const hraLine = findLine("HRA");
  const otLine = lines.find(l => (l.code === "OT" || l.code === "OVERTIME") && l.category === "EARNING");

  const basicSalary = parseFloat(basicLine?.amount ?? "0");
  const hra = parseFloat(hraLine?.amount ?? "0");
  const overtimeAmount = parseFloat(otLine?.amount ?? "0");

  const reservedCodes = new Set(["BASIC", "HRA", "OT", "OVERTIME"]);
  const allowances = lines
    .filter(l => l.category === "EARNING" && !reservedCodes.has(l.code))
    .reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);

  return {
    orgName: org.name,
    orgAddress: org.address,
    employeeName: employee.name,
    employeeId: employee.employeeId,
    designation: employee.designation,
    department: employee.department,
    panNumber: employee.pan,
    pfUan: employee.pfUan,
    bankName: employee.bankName,
    maskedAccount: employee.maskedAccount,
    ifsc: employee.ifsc,
    joiningDate: employee.joiningDate,
    monthLabel: fmtMonthYear(month),
    basicSalary,
    hra,
    allowances,
    overtimeAmount,
    grossSalary: parseFloat(totals.gross) || 0,
    deductions: parseFloat(totals.deductions) || 0,
    netSalary: parseFloat(totals.net) || 0,
  };
}
