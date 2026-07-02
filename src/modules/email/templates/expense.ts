import { getEmailTemplate, escapeHtml } from "./base";
import { renderButton, renderKeyValueRows, renderCallout, renderBadge } from "./components";

export function getExpenseSubmittedEmailTemplate(
  approverName: string,
  employeeName: string,
  category: string,
  amount: string,
  description: string,
  expenseLink: string
): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Employee", value: employeeName },
    { label: "Category", value: category },
    { label: "Amount", value: amount },
  ];
  if (description) {
    rows.push({ label: "Description", value: description });
  }
  const content = `<p class="email-text">Hi ${escapeHtml(approverName)},</p>
<p class="email-text">${escapeHtml(employeeName)} has submitted an expense claim that requires your approval.</p>
${renderKeyValueRows(rows)}
${renderButton("Review claim", expenseLink)}`;
  return getEmailTemplate({
    title: `New expense claim from ${escapeHtml(employeeName)}`,
    preheader: `${escapeHtml(employeeName)} submitted a ${escapeHtml(amount)} expense claim — your review is needed.`,
    content,
  });
}

export function getExpenseApprovedEmailTemplate(
  employeeName: string,
  category: string,
  amount: string,
  approverName: string
): string {
  const content = `<p class="email-text">Hi ${escapeHtml(employeeName)},</p>
<p class="email-text">Your expense claim has been approved.</p>
<p style="margin:0 0 16px 0;">${renderBadge("Approved", "success")}</p>
${renderKeyValueRows([
  { label: "Category", value: category },
  { label: "Amount", value: amount },
  { label: "Approved by", value: approverName },
])}
${renderCallout("Reimbursement will be processed in the next payout cycle.", "info")}`;
  return getEmailTemplate({
    title: "Your expense claim was approved",
    preheader: `Your ${escapeHtml(amount)} expense claim in ${escapeHtml(category)} has been approved by ${escapeHtml(approverName)}.`,
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
  const content = `<p class="email-text">Hi ${escapeHtml(employeeName)},</p>
<p class="email-text">Your expense claim was not approved.</p>
<p style="margin:0 0 16px 0;">${renderBadge("Rejected", "danger")}</p>
${renderKeyValueRows([
  { label: "Category", value: category },
  { label: "Amount", value: amount },
  { label: "Reviewed by", value: approverName },
])}
${renderCallout(escapeHtml(reason), "warning")}`;
  return getEmailTemplate({
    title: "Your expense claim was rejected",
    preheader: `Your ${escapeHtml(amount)} expense claim in ${escapeHtml(category)} was not approved.`,
    content,
  });
}

export function getExpensePaidEmailTemplate(
  employeeName: string,
  category: string,
  amount: string,
  transactionRef?: string
): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Amount", value: amount },
    { label: "Category", value: category },
  ];
  if (transactionRef) {
    rows.push({ label: "Transaction ref", value: transactionRef });
  }
  const content = `<p class="email-text">Hi ${escapeHtml(employeeName)},</p>
<p class="email-text">Your expense reimbursement has been processed and the amount has been credited to your account.</p>
${renderKeyValueRows(rows)}`;
  return getEmailTemplate({
    title: "Your expense reimbursement was paid",
    preheader: `Your ${escapeHtml(amount)} expense reimbursement for ${escapeHtml(category)} has been paid.`,
    content,
  });
}
