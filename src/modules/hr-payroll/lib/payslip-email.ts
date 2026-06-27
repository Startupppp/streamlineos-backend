function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PayslipEmailParams {
  employeeName: string;
  month: string;
  netSalary: string;
  orgName: string;
}

export function getPayslipEmailHtml(params: PayslipEmailParams): string {
  const sName = escapeHtml(params.employeeName);
  const sMonth = escapeHtml(params.month);
  const sNet = escapeHtml(params.netSalary);
  const sOrg = escapeHtml(params.orgName);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Payslip is Ready</title>
</head>
<body style="margin:0;padding:0;background-color:#f6f9fc;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="width:100%;background-color:#f6f9fc;padding:40px 0;">
    <div style="max-width:600px;margin:0 auto;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
      <div style="background:linear-gradient(135deg,#0f2b7f 0%,#1e40af 100%);padding:32px 48px;text-align:center;">
        <h1 style="color:#ffffff;font-size:24px;font-weight:700;margin:0;">Your Payslip is Ready</h1>
      </div>
      <div style="padding:40px 48px;color:#334155;line-height:1.6;">
        <p style="font-size:16px;color:#475569;margin:0 0 16px 0;">Dear <strong>${sName}</strong>,</p>
        <p style="font-size:16px;color:#475569;margin:0 0 16px 0;">
          Your payslip for <strong>${sMonth}</strong> has been processed and is attached to this email
          as a PDF. You can also view it anytime from the <strong>My Payslips</strong> section of your account.
        </p>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
          <p style="margin:0;color:#166534;font-size:13px;">Net Salary — ${sMonth}</p>
          <p style="margin:6px 0 0 0;color:#166534;font-size:26px;font-weight:700;">₹${sNet}</p>
        </div>
        <p style="font-size:16px;color:#475569;margin:0 0 16px 0;">
          The PDF attachment contains your full salary breakdown including earnings, deductions, and bank
          transfer details. If you have any questions, please contact the HR department.
        </p>
        <p style="font-size:16px;color:#475569;margin:0 0 16px 0;">Best regards,<br/><strong>${sOrg} — HR Team</strong></p>
      </div>
      <div style="background-color:#f8fafc;padding:24px 48px;text-align:center;border-top:1px solid #e2e8f0;">
        <p style="font-size:12px;color:#94a3b8;margin:0;">This is an automated email. Please do not reply to this message.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}
