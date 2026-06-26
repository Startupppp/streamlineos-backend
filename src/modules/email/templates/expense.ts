import { getEmailTemplate, escapeHtml } from "./base";

export function getExpenseSubmittedEmailTemplate(
  approverName: string,
  employeeName: string,
  category: string,
  amount: string,
  description: string,
  expenseLink: string
): string {
  const sApprover = escapeHtml(approverName);
  const sEmployee = escapeHtml(employeeName);
  const sCategory = escapeHtml(category);
  const sAmount = escapeHtml(amount);
  const sDescription = description ? escapeHtml(description) : "";
  const content = `
    <h2 class="email-title">🧾 New Expense Claim</h2>
    <p class="email-text">
      Hello <strong>${sApprover}</strong>,
    </p>

    <p class="email-text">
      <strong>${sEmployee}</strong> has submitted a new expense claim for your approval.
    </p>

    <div class="credential-box">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Category:</td>
          <td style="padding: 8px 0; color: #0f172a; font-weight: 600;">${sCategory}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Amount:</td>
          <td style="padding: 8px 0; color: #0f172a; font-weight: 700; font-size: 18px;">₹${sAmount}</td>
        </tr>
        ${sDescription ? `
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Description:</td>
          <td style="padding: 8px 0; color: #475569;">${sDescription}</td>
        </tr>
        ` : ''}
      </table>
    </div>

    <div style="text-align: center;">
      <a href="${expenseLink}" class="email-button">
        Review Expense Claim
      </a>
    </div>

    <div class="divider"></div>

    <p class="email-text" style="font-size: 14px; color: #64748b;">
      Please review and approve or reject this expense claim at your earliest convenience.
    </p>
  `;

  return getEmailTemplate({
    title: `New Expense Claim from ${sEmployee}`,
    preheader: `${sEmployee} submitted a ₹${sAmount} expense claim`,
    content,
  });
}

export function getExpenseApprovedEmailTemplate(
  employeeName: string,
  category: string,
  amount: string,
  approverName: string
): string {
  const sEmployee = escapeHtml(employeeName);
  const sCategory = escapeHtml(category);
  const sAmount = escapeHtml(amount);
  const sApprover = escapeHtml(approverName);
  const content = `
    <h2 class="email-title">✅ Expense Claim Approved</h2>
    <p class="email-text">
      Hello <strong>${sEmployee}</strong>,
    </p>

    <p class="email-text">
      Great news! Your expense claim has been <strong style="color: #16a34a;">approved</strong> by <strong>${sApprover}</strong>.
    </p>

    <div class="credential-box" style="border-left-color: #16a34a;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Category:</td>
          <td style="padding: 8px 0; color: #0f172a; font-weight: 600;">${sCategory}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Amount:</td>
          <td style="padding: 8px 0; color: #16a34a; font-weight: 700; font-size: 18px;">₹${sAmount}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Status:</td>
          <td style="padding: 8px 0;"><span style="background: #dcfce7; color: #16a34a; padding: 4px 12px; border-radius: 4px; font-weight: 600; font-size: 13px;">APPROVED</span></td>
        </tr>
      </table>
    </div>

    <div class="divider"></div>

    <p class="email-text" style="font-size: 14px; color: #64748b;">
      The reimbursement will be processed as per company policy. If you have any questions, please contact HR.
    </p>
  `;

  return getEmailTemplate({
    title: `Expense Claim Approved - ₹${sAmount}`,
    preheader: `Your ₹${sAmount} expense claim has been approved`,
    content,
  });
}

export function getExpenseRejectedEmailTemplate(
  employeeName: string,
  category: string,
  amount: string,
  approverName: string,
  reason: string
): string {
  const sEmployee = escapeHtml(employeeName);
  const sCategory = escapeHtml(category);
  const sAmount = escapeHtml(amount);
  const sApprover = escapeHtml(approverName);
  const sReason = escapeHtml(reason);
  const content = `
    <h2 class="email-title">❌ Expense Claim Rejected</h2>
    <p class="email-text">
      Hello <strong>${sEmployee}</strong>,
    </p>

    <p class="email-text">
      Unfortunately, your expense claim has been <strong style="color: #dc2626;">rejected</strong> by <strong>${sApprover}</strong>.
    </p>

    <div class="credential-box" style="border-left-color: #dc2626;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Category:</td>
          <td style="padding: 8px 0; color: #0f172a; font-weight: 600;">${sCategory}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Amount:</td>
          <td style="padding: 8px 0; color: #dc2626; font-weight: 700; font-size: 18px;">₹${sAmount}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Status:</td>
          <td style="padding: 8px 0;"><span style="background: #fee2e2; color: #dc2626; padding: 4px 12px; border-radius: 4px; font-weight: 600; font-size: 13px;">REJECTED</span></td>
        </tr>
      </table>
    </div>

    <div class="credential-box" style="margin-top: 16px; border-left-color: #f59e0b;">
      <p style="margin: 0 0 8px 0; color: #64748b; font-size: 14px;">Reason for rejection:</p>
      <p style="margin: 0; color: #0f172a; font-style: italic;">"${sReason}"</p>
    </div>

    <div class="divider"></div>

    <p class="email-text" style="font-size: 14px; color: #64748b;">
      If you believe this is an error or have questions, please contact your manager or HR.
    </p>
  `;

  return getEmailTemplate({
    title: `Expense Claim Rejected - ₹${sAmount}`,
    preheader: `Your ₹${sAmount} expense claim has been rejected`,
    content,
  });
}

export function getExpensePaidEmailTemplate(
  employeeName: string,
  category: string,
  amount: string,
  transactionRef?: string
): string {
  const sEmployee = escapeHtml(employeeName);
  const sCategory = escapeHtml(category);
  const sAmount = escapeHtml(amount);
  const sRef = transactionRef ? escapeHtml(transactionRef) : undefined;
  const content = `
    <h2 class="email-title">💰 Expense Reimbursed</h2>
    <p class="email-text">
      Hello <strong>${sEmployee}</strong>,
    </p>

    <p class="email-text">
      Your expense claim has been <strong style="color: #2563eb;">reimbursed</strong>! The amount has been credited to your account.
    </p>

    <div class="credential-box" style="border-left-color: #2563eb;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Category:</td>
          <td style="padding: 8px 0; color: #0f172a; font-weight: 600;">${sCategory}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Amount Reimbursed:</td>
          <td style="padding: 8px 0; color: #2563eb; font-weight: 700; font-size: 18px;">₹${sAmount}</td>
        </tr>
        ${sRef ? `
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Transaction Ref:</td>
          <td style="padding: 8px 0; color: #0f172a; font-family: monospace;">${sRef}</td>
        </tr>
        ` : ''}
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Status:</td>
          <td style="padding: 8px 0;"><span style="background: #dbeafe; color: #2563eb; padding: 4px 12px; border-radius: 4px; font-weight: 600; font-size: 13px;">PAID</span></td>
        </tr>
      </table>
    </div>

    <div class="divider"></div>

    <p class="email-text" style="font-size: 14px; color: #64748b;">
      Please check your bank account for the credited amount. Contact HR if you don't receive the payment within 2-3 business days.
    </p>
  `;

  return getEmailTemplate({
    title: `Expense Reimbursed - ₹${sAmount}`,
    preheader: `Your ₹${sAmount} expense has been reimbursed`,
    content,
  });
}
