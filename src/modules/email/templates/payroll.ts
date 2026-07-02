import { getEmailTemplate, escapeHtml } from "./base";
import { renderKeyValueRows, renderCallout } from "./components";

export interface PayslipEmailParams {
  employeeName: string;
  month: string;
  netSalary: string;
  orgName: string;
}

export function getPayslipEmailTemplate(params: PayslipEmailParams): { subject: string; html: string } {
  const { employeeName, month, netSalary, orgName } = params;
  const subject = `Your payslip for ${month}`;
  const firstName = escapeHtml(employeeName.split(" ")[0] ?? employeeName);
  const content = `
<h1 class="email-title">Your payslip for ${escapeHtml(month)}</h1>
<p class="email-text">Hi ${firstName}, your payslip for ${escapeHtml(month)} is attached to this email as a PDF.</p>
${renderKeyValueRows([
  { label: "Period", value: month },
  { label: "Net pay", value: `₹${netSalary}` },
])}
${renderCallout("The PDF contains your full salary breakdown including earnings, deductions, and bank transfer details. Contact HR if you have any questions.", "info")}
`;
  return {
    subject,
    html: getEmailTemplate({
      title: subject,
      preheader: `Your ${escapeHtml(month)} payslip from ${escapeHtml(orgName)} is attached.`,
      content,
    }),
  };
}
