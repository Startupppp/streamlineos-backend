import { getEmailTemplate, appUrl, escapeHtml } from "./base";
import { renderButton, renderKeyValueRows, renderBadge } from "./components";

export function getTaskAssignedEmailTemplate(
  assigneeName: string,
  taskTitle: string,
  taskType: string,
  dueDate: string | null,
  creatorName: string,
  entityLabel?: string
): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Task", value: taskTitle },
    { label: "Type", value: taskType },
  ];
  if (dueDate) rows.push({ label: "Due", value: dueDate });
  if (entityLabel) rows.push({ label: "Related to", value: entityLabel });
  rows.push({ label: "Assigned by", value: creatorName });
  const content = `
    <p class="email-text">Hi ${escapeHtml(assigneeName)},</p>
    <p class="email-text">A task has been assigned to you by ${escapeHtml(creatorName)}.</p>
    ${renderKeyValueRows(rows)}
    ${renderButton("Open task", `${appUrl}/crm/tasks`)}
  `;
  return getEmailTemplate({
    title: `Task assigned: ${escapeHtml(taskTitle)}`,
    preheader: `${escapeHtml(creatorName)} assigned you a task${dueDate ? ` due ${escapeHtml(dueDate)}` : ""}`,
    content,
  });
}

export function getDealStageChangeEmailTemplate(
  recipientName: string,
  dealName: string,
  previousStage: string,
  newStage: string,
  dealValue: string | null,
  changedBy: string,
  dealId: number
): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Deal", value: dealName },
    { label: "From", value: previousStage },
    { label: "To", value: newStage },
  ];
  if (dealValue) rows.push({ label: "Value", value: dealValue });
  rows.push({ label: "Updated by", value: changedBy });
  const content = `
    <p class="email-text">Hi ${escapeHtml(recipientName)},</p>
    <p class="email-text">The stage for deal <strong>${escapeHtml(dealName)}</strong> has been updated.</p>
    ${renderKeyValueRows(rows)}
    ${renderButton("Open deal", `${appUrl}/crm/deals/${dealId}`)}
  `;
  return getEmailTemplate({
    title: `Deal stage updated: ${escapeHtml(dealName)}`,
    preheader: `${escapeHtml(dealName)} moved from ${escapeHtml(previousStage)} to ${escapeHtml(newStage)}`,
    content,
  });
}

export function getLeadAssignedEmailTemplate(
  repName: string,
  leadName: string,
  source: string,
  priority: string,
  assignedBy: string
): string {
  const priorityTone = priority === "HOT" ? "danger" : priority === "WARM" ? "warning" : "info";
  const badge = renderBadge(priority, priorityTone);
  const rows: Array<{ label: string; value: string }> = [
    { label: "Lead", value: leadName },
    { label: "Source", value: source },
    { label: "Assigned by", value: assignedBy },
  ];
  const content = `
    <p class="email-text">Hi ${escapeHtml(repName)},</p>
    <p class="email-text">A lead has been assigned to you. Priority: ${badge}</p>
    ${renderKeyValueRows(rows)}
    ${renderButton("Open lead", `${appUrl}/crm/leads`)}
  `;
  return getEmailTemplate({
    title: `Lead assigned: ${escapeHtml(leadName)}`,
    preheader: `${escapeHtml(leadName)} assigned to you by ${escapeHtml(assignedBy)}`,
    content,
  });
}

export function getReviewAssignedEmailTemplate(
  employeeName: string,
  reviewerName: string,
  periodStart: string,
  periodEnd: string
): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Review cycle", value: `${periodStart} – ${periodEnd}` },
    { label: "Reviewer", value: reviewerName },
  ];
  const content = `
    <p class="email-text">Hi ${escapeHtml(employeeName)},</p>
    <p class="email-text">A performance review has been assigned to you.</p>
    ${renderKeyValueRows(rows)}
    ${renderButton("Start review", `${appUrl}/hr/performance`)}
  `;
  return getEmailTemplate({
    title: "Performance review assigned",
    preheader: `Your performance review for ${escapeHtml(periodStart)} – ${escapeHtml(periodEnd)} is ready`,
    content,
  });
}

export function getAssetAssignedEmailTemplate(
  employeeName: string,
  assetName: string,
  assetType: string,
  serialNumber: string | null
): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Asset", value: assetName },
    { label: "Type", value: assetType },
  ];
  if (serialNumber) rows.push({ label: "Serial number", value: serialNumber });
  const content = `
    <p class="email-text">Hi ${escapeHtml(employeeName)},</p>
    <p class="email-text">A company asset has been assigned to you.</p>
    ${renderKeyValueRows(rows)}
    ${renderButton("View my assets", `${appUrl}/hr/assets`)}
  `;
  return getEmailTemplate({
    title: `Asset assigned: ${escapeHtml(assetName)}`,
    preheader: `${escapeHtml(assetName)} has been assigned to you`,
    content,
  });
}

export function getPayrollApprovedEmailTemplate(
  employeeName: string,
  month: string,
  approverName: string
): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Period", value: month },
    { label: "Approved by", value: approverName },
  ];
  const content = `
    <p class="email-text">Hi ${escapeHtml(employeeName)},</p>
    <p class="email-text">Your payroll for <strong>${escapeHtml(month)}</strong> has been approved and is being processed. Your payslip will be available once payment is complete.</p>
    ${renderKeyValueRows(rows)}
    ${renderButton("View payslips", `${appUrl}/hr/my-payslips`)}
  `;
  return getEmailTemplate({
    title: `Payroll approved for ${escapeHtml(month)}`,
    preheader: `Your payroll for ${escapeHtml(month)} was approved by ${escapeHtml(approverName)}`,
    content,
  });
}
