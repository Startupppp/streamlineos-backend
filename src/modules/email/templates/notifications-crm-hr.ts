import { getEmailTemplate, appUrl, escapeHtml } from "./base";

export function getTaskAssignedEmailTemplate(
  assigneeName: string,
  taskTitle: string,
  taskType: string,
  dueDate: string | null,
  creatorName: string,
  entityLabel?: string
): string {
  const content = `
    <h2 class="email-title">📌 New Task Assigned</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(assigneeName)}</strong>, a new task has been assigned to you.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Task:</span>
        <span class="credential-value">${escapeHtml(taskTitle)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Type:</span>
        <span class="credential-value">${escapeHtml(taskType)}</span>
      </div>
      ${dueDate ? `
      <div class="credential-item">
        <span class="credential-label">Due Date:</span>
        <span class="credential-value">${escapeHtml(dueDate)}</span>
      </div>` : ""}
      ${entityLabel ? `
      <div class="credential-item">
        <span class="credential-label">Related to:</span>
        <span class="credential-value">${escapeHtml(entityLabel)}</span>
      </div>` : ""}
      <div class="credential-item">
        <span class="credential-label">Assigned by:</span>
        <span class="credential-value">${escapeHtml(creatorName)}</span>
      </div>
    </div>
    <div style="text-align: center;">
      <a href="${appUrl}/crm/tasks" class="email-button">View Tasks</a>
    </div>
  `;
  return getEmailTemplate({ title: "New Task Assigned", content });
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
  const stageColor = newStage === "WON" ? "#16a34a" : newStage === "LOST" ? "#dc2626" : "#2563eb";
  const content = `
    <h2 class="email-title">${newStage === "WON" ? "🎉" : newStage === "LOST" ? "😞" : "📊"} Deal Stage Updated</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(recipientName)}</strong>, a deal stage has been updated.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Deal:</span>
        <span class="credential-value">${escapeHtml(dealName)}</span>
      </div>
      ${dealValue ? `
      <div class="credential-item">
        <span class="credential-label">Value:</span>
        <span class="credential-value">₹${escapeHtml(dealValue)}</span>
      </div>` : ""}
      <div class="credential-item">
        <span class="credential-label">Stage:</span>
        <span class="credential-value">${escapeHtml(previousStage)} → <strong style="color: ${stageColor};">${escapeHtml(newStage)}</strong></span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Updated by:</span>
        <span class="credential-value">${escapeHtml(changedBy)}</span>
      </div>
    </div>
    <div style="text-align: center;">
      <a href="${appUrl}/crm/deals/${dealId}" class="email-button">View Deal</a>
    </div>
  `;
  return getEmailTemplate({ title: `Deal ${newStage === "WON" ? "Won" : newStage === "LOST" ? "Lost" : "Updated"}`, content });
}

export function getLeadAssignedEmailTemplate(
  repName: string,
  leadName: string,
  source: string,
  priority: string,
  assignedBy: string
): string {
  const priorityColor = priority === "HOT" ? "#dc2626" : priority === "WARM" ? "#ea580c" : "#65a30d";
  const content = `
    <h2 class="email-title">🎯 New Lead Assigned</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(repName)}</strong>, a new lead has been assigned to you.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Lead Name:</span>
        <span class="credential-value">${escapeHtml(leadName)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Source:</span>
        <span class="credential-value">${escapeHtml(source)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Priority:</span>
        <span class="credential-value" style="color: ${priorityColor}; font-weight: 600;">${escapeHtml(priority)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Assigned by:</span>
        <span class="credential-value">${escapeHtml(assignedBy)}</span>
      </div>
    </div>
    <div style="text-align: center;">
      <a href="${appUrl}/crm/leads" class="email-button">View Leads</a>
    </div>
  `;
  return getEmailTemplate({ title: "New Lead Assigned", content });
}

export function getReviewAssignedEmailTemplate(
  employeeName: string,
  reviewerName: string,
  periodStart: string,
  periodEnd: string
): string {
  const content = `
    <h2 class="email-title">📝 Performance Review Assigned</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(employeeName)}</strong>, a performance review has been initiated for you.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Reviewer:</span>
        <span class="credential-value">${escapeHtml(reviewerName)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Review Period:</span>
        <span class="credential-value">${escapeHtml(periodStart)} to ${escapeHtml(periodEnd)}</span>
      </div>
    </div>
    <div style="text-align: center;">
      <a href="${appUrl}/hr/performance" class="email-button">View Review</a>
    </div>
  `;
  return getEmailTemplate({ title: "Performance Review Assigned", content });
}

export function getAssetAssignedEmailTemplate(
  employeeName: string,
  assetName: string,
  assetType: string,
  serialNumber: string | null
): string {
  const content = `
    <h2 class="email-title">💻 Asset Assigned to You</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(employeeName)}</strong>, a company asset has been assigned to you.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Asset:</span>
        <span class="credential-value">${escapeHtml(assetName)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Type:</span>
        <span class="credential-value">${escapeHtml(assetType)}</span>
      </div>
      ${serialNumber ? `
      <div class="credential-item">
        <span class="credential-label">Serial Number:</span>
        <span class="credential-value">${escapeHtml(serialNumber)}</span>
      </div>` : ""}
    </div>
    <p class="email-text">
      Please take care of this equipment. Report any issues to IT or HR.
    </p>
    <div style="text-align: center;">
      <a href="${appUrl}/hr/assets" class="email-button">View My Assets</a>
    </div>
  `;
  return getEmailTemplate({ title: "Asset Assigned", content });
}

export function getPayrollApprovedEmailTemplate(
  employeeName: string,
  month: string,
  approverName: string
): string {
  const content = `
    <h2 class="email-title">✅ Payroll Approved</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(employeeName)}</strong>, your payroll for <strong>${escapeHtml(month)}</strong> has been approved and is being processed.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Month:</span>
        <span class="credential-value">${escapeHtml(month)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Approved by:</span>
        <span class="credential-value">${escapeHtml(approverName)}</span>
      </div>
    </div>
    <p class="email-text">
      Your payslip will be available once payment is processed.
    </p>
    <div style="text-align: center;">
      <a href="${appUrl}/hr/my-payslips" class="email-button">View Payslips</a>
    </div>
  `;
  return getEmailTemplate({ title: "Payroll Approved", content });
}
