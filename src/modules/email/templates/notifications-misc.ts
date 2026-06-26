import { getEmailTemplate, appUrl, escapeHtml } from "./base";

export function getOnboardingWelcomeEmailTemplate(
  employeeName: string,
  designation: string,
  joiningDate: string,
  taskCount: number
): string {
  const content = `
    <h2 class="email-title">🎉 Welcome to the Team!</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(employeeName)}</strong>, welcome aboard! We're excited to have you join us.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Role:</span>
        <span class="credential-value">${escapeHtml(designation)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Joining Date:</span>
        <span class="credential-value">${escapeHtml(joiningDate)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Onboarding Tasks:</span>
        <span class="credential-value">${taskCount} tasks to complete</span>
      </div>
    </div>
    <p class="email-text">
      Your onboarding tasks have been set up. Please log in to your dashboard to get started with your onboarding checklist.
    </p>
    <div style="text-align: center;">
      <a href="${appUrl}/hr/onboarding/my-tasks" class="email-button">Start Onboarding</a>
    </div>
    <div class="security-notice">
      <p class="security-text">
        💡 If this is your first time logging in, you'll be prompted to change your temporary password.
      </p>
    </div>
  `;
  return getEmailTemplate({ title: "Welcome to StreamlineOS", preheader: "Your onboarding journey starts now!", content });
}

export function getOnboardingTaskEmailTemplate(
  recipientName: string,
  employeeName: string,
  taskRole: string,
  taskCount: number
): string {
  const roleLabel = taskRole === "IT" ? "IT Setup" : taskRole === "HR" ? "HR" : "Manager";
  const content = `
    <h2 class="email-title">📋 Onboarding Tasks Assigned</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(recipientName)}</strong>, new onboarding tasks have been assigned to you.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">New Employee:</span>
        <span class="credential-value">${escapeHtml(employeeName)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Your Role:</span>
        <span class="credential-value">${roleLabel}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Tasks Assigned:</span>
        <span class="credential-value">${taskCount}</span>
      </div>
    </div>
    <div style="text-align: center;">
      <a href="${appUrl}/hr/onboarding" class="email-button">View Onboarding Tasks</a>
    </div>
  `;
  return getEmailTemplate({ title: "Onboarding Tasks Assigned", content });
}

export function getOnboardingCompleteEmployeeEmailTemplate(
  employeeName: string
): string {
  const content = `
    <h2 class="email-title">🎉 Onboarding Complete!</h2>
    <p class="email-text">
      Congratulations <strong>${escapeHtml(employeeName)}</strong>, you've completed all your onboarding tasks!
    </p>
    <p class="email-text">
      Your onboarding journey is now complete. You're all set to get started with your day-to-day work.
      If you have any questions, don't hesitate to reach out to your manager or HR.
    </p>
    <div style="text-align: center;">
      <a href="${appUrl}/hr/onboarding/my-tasks" class="email-button">View Dashboard</a>
    </div>
  `;
  return getEmailTemplate({ title: "Onboarding Complete", preheader: "You're all set!", content });
}

export function getOnboardingCompleteHrEmailTemplate(
  hrName: string,
  employeeName: string
): string {
  const content = `
    <h2 class="email-title">✅ Onboarding Complete</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(hrName)}</strong>, <strong>${escapeHtml(employeeName)}</strong> has completed all onboarding tasks.
    </p>
    <div style="text-align: center;">
      <a href="${appUrl}/hr/onboarding" class="email-button">View Onboarding</a>
    </div>
  `;
  return getEmailTemplate({ title: "Onboarding Complete", content });
}

export function getTicketCreatedEmailTemplate(
  assigneeName: string,
  ticketTitle: string,
  priority: string,
  creatorName: string,
  ticketId: number
): string {
  const priorityColor = priority === "URGENT" ? "#dc2626" : priority === "HIGH" ? "#ea580c" : priority === "MEDIUM" ? "#ca8a04" : "#65a30d";
  const content = `
    <h2 class="email-title">🎫 New Support Ticket Assigned</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(assigneeName)}</strong>, a new support ticket has been assigned to you.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Ticket:</span>
        <span class="credential-value">#${ticketId} — ${escapeHtml(ticketTitle)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Priority:</span>
        <span class="credential-value" style="color: ${priorityColor}; font-weight: 600;">${escapeHtml(priority)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Created by:</span>
        <span class="credential-value">${escapeHtml(creatorName)}</span>
      </div>
    </div>
    <div style="text-align: center;">
      <a href="${appUrl}/support/${ticketId}" class="email-button">View Ticket</a>
    </div>
  `;
  return getEmailTemplate({ title: "Support Ticket Assigned", content });
}

export function getTicketReplyEmailTemplate(
  recipientName: string,
  ticketTitle: string,
  ticketId: number,
  authorName: string,
  messagePreview: string
): string {
  const content = `
    <h2 class="email-title">💬 New Reply on Ticket #${ticketId}</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(recipientName)}</strong>, there's a new reply on your support ticket.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Ticket:</span>
        <span class="credential-value">${escapeHtml(ticketTitle)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Reply from:</span>
        <span class="credential-value">${escapeHtml(authorName)}</span>
      </div>
    </div>
    <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin: 16px 0;">
      <p style="color: #475569; font-size: 14px; margin: 0; font-style: italic;">"${escapeHtml(messagePreview.slice(0, 200))}${messagePreview.length > 200 ? "..." : ""}"</p>
    </div>
    <div style="text-align: center;">
      <a href="${appUrl}/support/${ticketId}" class="email-button">View Full Conversation</a>
    </div>
  `;
  return getEmailTemplate({ title: "New Reply on Support Ticket", content });
}

export function getTicketStatusEmailTemplate(
  recipientName: string,
  ticketTitle: string,
  ticketId: number,
  newStatus: string,
  updatedBy: string
): string {
  const statusColor = newStatus === "RESOLVED" || newStatus === "CLOSED" ? "#16a34a" : newStatus === "IN_PROGRESS" ? "#2563eb" : "#ca8a04";
  const content = `
    <h2 class="email-title">🔄 Ticket Status Updated</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(recipientName)}</strong>, the status of your support ticket has been updated.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Ticket:</span>
        <span class="credential-value">#${ticketId} — ${escapeHtml(ticketTitle)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">New Status:</span>
        <span class="credential-value" style="color: ${statusColor}; font-weight: 600;">${escapeHtml(newStatus)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Updated by:</span>
        <span class="credential-value">${escapeHtml(updatedBy)}</span>
      </div>
    </div>
    <div style="text-align: center;">
      <a href="${appUrl}/support/${ticketId}" class="email-button">View Ticket</a>
    </div>
  `;
  return getEmailTemplate({ title: "Ticket Status Updated", content });
}

export function getHelpdeskTicketEmailTemplate(
  recipientName: string,
  ticketTitle: string,
  category: string,
  priority: string,
  creatorName: string
): string {
  const priorityColor = priority === "URGENT" ? "#dc2626" : priority === "HIGH" ? "#ea580c" : priority === "MEDIUM" ? "#ca8a04" : "#65a30d";
  const content = `
    <h2 class="email-title">🎫 New Helpdesk Ticket</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(recipientName)}</strong>, a new helpdesk ticket has been submitted.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Title:</span>
        <span class="credential-value">${escapeHtml(ticketTitle)}</span>
      </div>
      ${category ? `
      <div class="credential-item">
        <span class="credential-label">Category:</span>
        <span class="credential-value">${escapeHtml(category)}</span>
      </div>` : ""}
      <div class="credential-item">
        <span class="credential-label">Priority:</span>
        <span class="credential-value" style="color: ${priorityColor}; font-weight: 600;">${escapeHtml(priority)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Submitted by:</span>
        <span class="credential-value">${escapeHtml(creatorName)}</span>
      </div>
    </div>
    <div style="text-align: center;">
      <a href="${appUrl}/hr/helpdesk" class="email-button">View Ticket</a>
    </div>
  `;
  return getEmailTemplate({ title: "New Helpdesk Ticket", content });
}

export function getWorkLogApprovedEmailTemplate(
  employeeName: string,
  date: string,
  approverName: string
): string {
  const content = `
    <h2 class="email-title">✅ Work Log Approved</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(employeeName)}</strong>, your work log has been approved.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Date:</span>
        <span class="credential-value">${escapeHtml(date)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Approved by:</span>
        <span class="credential-value">${escapeHtml(approverName)}</span>
      </div>
    </div>
    <div style="text-align: center;">
      <a href="${appUrl}/hr/work-logs" class="email-button">View Work Logs</a>
    </div>
  `;
  return getEmailTemplate({ title: "Work Log Approved", content });
}

export function getWorkLogRejectedEmailTemplate(
  employeeName: string,
  date: string,
  approverName: string,
  reason?: string
): string {
  const content = `
    <h2 class="email-title">❌ Work Log Rejected</h2>
    <p class="email-text">
      Hi <strong>${escapeHtml(employeeName)}</strong>, your work log has been rejected.
    </p>
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Date:</span>
        <span class="credential-value">${escapeHtml(date)}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Rejected by:</span>
        <span class="credential-value">${escapeHtml(approverName)}</span>
      </div>
      ${reason ? `
      <div class="credential-item">
        <span class="credential-label">Reason:</span>
        <span class="credential-value">${escapeHtml(reason)}</span>
      </div>` : ""}
    </div>
    <p class="email-text">Please review and resubmit your work log.</p>
    <div style="text-align: center;">
      <a href="${appUrl}/hr/work-logs" class="email-button">Update Work Log</a>
    </div>
  `;
  return getEmailTemplate({ title: "Work Log Rejected", content });
}
