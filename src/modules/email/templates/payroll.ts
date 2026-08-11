import { getEmailTemplate, escapeHtml } from "./base";
import { renderKeyValueRows, renderCallout } from "./components";

/**
 * SEC-007. `netSalary` was rendered into the body and retained in `email_outbox.html`.
 * The figure is in the attached PDF, which is where it belongs — the email announces
 * that the payslip exists. The field is removed rather than left unused, so no caller
 * can reintroduce it without changing this type.
 */
export interface PayslipEmailParams {
  employeeName: string;
  month: string;
  orgName: string;
}

export function getPayslipEmailTemplate(params: PayslipEmailParams): { subject: string; html: string } {
  const { employeeName, month, orgName } = params;
  const subject = `Your payslip for ${month}`;
  const firstName = escapeHtml(employeeName.split(" ")[0] ?? employeeName);
  const content = `
<h1 class="email-title">Your payslip for ${escapeHtml(month)}</h1>
<p class="email-text">Hi ${firstName}, your payslip for ${escapeHtml(month)} is attached to this email as a PDF.</p>
${renderKeyValueRows([{ label: "Period", value: month }])}
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
