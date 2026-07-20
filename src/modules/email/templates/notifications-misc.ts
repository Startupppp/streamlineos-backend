import { getBrandName } from "../branding";
import { getEmailTemplate, appUrl, escapeHtml } from "./base";
import { renderButton, renderKeyValueRows, renderCallout, renderBadge } from "./components";
import type { Tone } from "./components";

export function getOnboardingWelcomeEmailTemplate(
  employeeName: string,
  designation: string,
  joiningDate: string,
  taskCount: number
): string {
  const brand = getBrandName();
  const rows: Array<{ label: string; value: string }> = [
    { label: "Role", value: designation },
    { label: "Onboarding starts", value: joiningDate },
    { label: "Tasks to complete", value: String(taskCount) },
  ];
  const content = `
    <p class="email-text">Hi ${escapeHtml(employeeName)},</p>
    <p class="email-text">Welcome — your onboarding starts on ${escapeHtml(joiningDate)}.</p>
    ${renderKeyValueRows(rows)}
    ${renderButton("Start onboarding", `${appUrl}/hr/onboarding/my-tasks`)}
  `;
  return getEmailTemplate({
    title: `Welcome to ${brand}`,
    preheader: `Your onboarding starts on ${escapeHtml(joiningDate)} — ${taskCount} task${taskCount !== 1 ? "s" : ""} to complete`,
    content,
  });
}

export function getOnboardingTaskEmailTemplate(
  recipientName: string,
  employeeName: string,
  taskRole: string,
  taskCount: number
): string {
  const roleLabel = taskRole === "IT" ? "IT Setup" : taskRole === "HR" ? "HR" : "Manager";
  const rows: Array<{ label: string; value: string }> = [
    { label: "New joiner", value: employeeName },
    { label: "Your role", value: roleLabel },
    { label: "Tasks assigned", value: String(taskCount) },
  ];
  const content = `
    <p class="email-text">Hi ${escapeHtml(recipientName)},</p>
    <p class="email-text">Onboarding tasks have been assigned to you for ${escapeHtml(employeeName)}.</p>
    ${renderKeyValueRows(rows)}
    ${renderButton("View tasks", `${appUrl}/hr/onboarding`)}
  `;
  return getEmailTemplate({
    title: "Onboarding tasks assigned to you",
    preheader: `${taskCount} onboarding task${taskCount !== 1 ? "s" : ""} assigned for ${escapeHtml(employeeName)}`,
    content,
  });
}

export function getOnboardingCompleteEmployeeEmailTemplate(
  employeeName: string
): string {
  const content = `
    <p class="email-text">Hi ${escapeHtml(employeeName)},</p>
    <p class="email-text">You have completed all your onboarding tasks. Your account is fully set up.</p>
    ${renderButton("Go to dashboard", `${appUrl}/dashboard`)}
  `;
  return getEmailTemplate({
    title: "Onboarding complete",
    preheader: "All onboarding tasks are done — your account is ready",
    content,
  });
}

export function getOnboardingCompleteHrEmailTemplate(
  hrName: string,
  employeeName: string
): string {
  const completedOn = new Date().toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const rows: Array<{ label: string; value: string }> = [
    { label: "Employee", value: employeeName },
    { label: "Completed on", value: completedOn },
  ];
  const content = `
    <p class="email-text">Hi ${escapeHtml(hrName)},</p>
    <p class="email-text">${escapeHtml(employeeName)} has completed all onboarding tasks.</p>
    ${renderKeyValueRows(rows)}
    ${renderButton("View onboarding", `${appUrl}/hr/onboarding`)}
  `;
  return getEmailTemplate({
    title: `${escapeHtml(employeeName)} completed onboarding`,
    preheader: `${escapeHtml(employeeName)} completed all onboarding tasks`,
    content,
  });
}

export function getTicketCreatedEmailTemplate(
  assigneeName: string,
  ticketTitle: string,
  priority: string,
  creatorName: string,
  ticketId: number
): string {
  const priorityTone: Tone = priority === "URGENT" || priority === "HIGH" ? "danger" : priority === "MEDIUM" ? "warning" : "info";
  const badge = renderBadge(priority, priorityTone);
  const rows: Array<{ label: string; value: string }> = [
    { label: "Ticket", value: `#${ticketId} — ${ticketTitle}` },
    { label: "Created by", value: creatorName },
  ];
  const content = `
    <p class="email-text">Hi ${escapeHtml(assigneeName)},</p>
    <p class="email-text">A new support ticket has been assigned to you. Priority: ${badge}</p>
    ${renderKeyValueRows(rows)}
    ${renderButton("Open ticket", `${appUrl}/support/${ticketId}`)}
  `;
  return getEmailTemplate({
    title: `New support ticket: ${escapeHtml(ticketTitle)}`,
    preheader: `${escapeHtml(creatorName)} created a ${escapeHtml(priority.toLowerCase())} priority ticket`,
    content,
  });
}

export function getTicketReplyEmailTemplate(
  recipientName: string,
  ticketTitle: string,
  ticketId: number,
  authorName: string,
  messagePreview: string
): string {
  const preview = escapeHtml(messagePreview.slice(0, 200)) + (messagePreview.length > 200 ? "..." : "");
  const content = `
    <p class="email-text">Hi ${escapeHtml(recipientName)},</p>
    <p class="email-text">${escapeHtml(authorName)} replied on ticket #${ticketId} — ${escapeHtml(ticketTitle)}.</p>
    ${renderCallout(preview, "info")}
    ${renderButton("View conversation", `${appUrl}/support/${ticketId}`)}
  `;
  return getEmailTemplate({
    title: `New reply on ticket #${ticketId}`,
    preheader: `${escapeHtml(authorName)} replied on ticket #${ticketId}`,
    content,
  });
}

export function getTicketStatusEmailTemplate(
  recipientName: string,
  ticketTitle: string,
  ticketId: number,
  newStatus: string,
  updatedBy: string
): string {
  const statusTone: Tone =
    newStatus === "RESOLVED" || newStatus === "CLOSED"
      ? "success"
      : newStatus === "IN_PROGRESS"
        ? "info"
        : "warning";
  const badge = renderBadge(newStatus, statusTone);
  const content = `
    <p class="email-text">Hi ${escapeHtml(recipientName)},</p>
    <p class="email-text">Ticket #${ticketId} — <strong>${escapeHtml(ticketTitle)}</strong> has been updated: ${badge}</p>
    ${renderButton("View ticket", `${appUrl}/support/${ticketId}`)}
  `;
  return getEmailTemplate({
    title: `Ticket #${ticketId} status: ${escapeHtml(newStatus)}`,
    preheader: `${escapeHtml(updatedBy)} updated ticket #${ticketId} to ${escapeHtml(newStatus)}`,
    content,
  });
}

export type TicketEscalationLevel =
  | "first_response_due_soon"
  | "first_response_breached"
  | "resolution_due_soon"
  | "resolution_breached";

const ESCALATION_LEVEL_COPY: Record<TicketEscalationLevel, { label: string; tone: Tone }> = {
  first_response_due_soon: { label: "First response due soon", tone: "warning" },
  first_response_breached: { label: "First response SLA breached", tone: "danger" },
  resolution_due_soon: { label: "Resolution due soon", tone: "warning" },
  resolution_breached: { label: "Resolution SLA breached", tone: "danger" },
};

export function getTicketEscalationEmailTemplate(
  recipientName: string,
  ticketTitle: string,
  ticketId: number,
  escalationLevel: TicketEscalationLevel,
): string {
  const { label, tone } = ESCALATION_LEVEL_COPY[escalationLevel];
  const badge = renderBadge(label, tone);
  const content = `
    <p class="email-text">Hi ${escapeHtml(recipientName)},</p>
    <p class="email-text">Ticket #${ticketId} — <strong>${escapeHtml(ticketTitle)}</strong> needs attention: ${badge}</p>
    ${renderButton("View ticket", `${appUrl}/support/${ticketId}`)}
  `;
  return getEmailTemplate({
    title: `SLA alert: ticket #${ticketId}`,
    preheader: `${label} for ticket #${ticketId}`,
    content,
  });
}

export function getHelpdeskTicketEmailTemplate(
  recipientName: string,
  ticketTitle: string,
  category: string,
  priority: string,
  creatorName: string
): string {
  const priorityTone: Tone = priority === "URGENT" || priority === "HIGH" ? "danger" : priority === "MEDIUM" ? "warning" : "info";
  const badge = renderBadge(priority, priorityTone);
  const rows: Array<{ label: string; value: string }> = [
    { label: "Title", value: ticketTitle },
  ];
  if (category) rows.push({ label: "Category", value: category });
  rows.push({ label: "Submitted by", value: creatorName });
  const content = `
    <p class="email-text">Hi ${escapeHtml(recipientName)},</p>
    <p class="email-text">A new helpdesk ticket has been submitted. Priority: ${badge}</p>
    ${renderKeyValueRows(rows)}
    ${renderButton("View ticket", `${appUrl}/hr/helpdesk`)}
  `;
  return getEmailTemplate({
    title: `New helpdesk ticket: ${escapeHtml(ticketTitle)}`,
    preheader: `${escapeHtml(creatorName)} submitted a ${escapeHtml(priority.toLowerCase())} priority helpdesk ticket`,
    content,
  });
}

export function getWorkLogApprovedEmailTemplate(
  employeeName: string,
  date: string,
  approverName: string
): string {
  const badge = renderBadge("Approved", "success");
  const rows: Array<{ label: string; value: string }> = [
    { label: "Period", value: date },
    { label: "Approved by", value: approverName },
  ];
  const content = `
    <p class="email-text">Hi ${escapeHtml(employeeName)},</p>
    <p class="email-text">Your work log has been reviewed. ${badge}</p>
    ${renderKeyValueRows(rows)}
  `;
  return getEmailTemplate({
    title: "Your work log was approved",
    preheader: `${escapeHtml(approverName)} approved your work log for ${escapeHtml(date)}`,
    content,
  });
}

export function getWorkLogRejectedEmailTemplate(
  employeeName: string,
  date: string,
  approverName: string,
  reason?: string
): string {
  const calloutText = reason
    ? escapeHtml(reason)
    : `${escapeHtml(approverName)} has requested changes to your work log for ${escapeHtml(date)}.`;
  const content = `
    <p class="email-text">Hi ${escapeHtml(employeeName)},</p>
    <p class="email-text">Your work log for ${escapeHtml(date)} needs changes.</p>
    ${renderCallout(calloutText, "warning")}
    ${renderButton("Edit work log", `${appUrl}/hr/work-logs`)}
  `;
  return getEmailTemplate({
    title: "Your work log needs changes",
    preheader: `${escapeHtml(approverName)} requested changes to your work log for ${escapeHtml(date)}`,
    content,
  });
}

export function getOnboardingReminderEmailTemplate(
  employeeName: string,
  pendingTasks: number,
  totalTasks: number,
): string {
  const content = `
    <p class="email-text">Hi ${escapeHtml(employeeName)},</p>
    <p class="email-text">You have <strong>${pendingTasks}</strong> pending onboarding task${pendingTasks !== 1 ? "s" : ""} out of <strong>${totalTasks}</strong> total. Log in and complete your remaining tasks to finish your onboarding.</p>
    ${renderButton("Complete tasks", `${appUrl}/hr/onboarding/my-tasks`)}
  `;
  return getEmailTemplate({
    title: "Onboarding reminder",
    preheader: `${pendingTasks} onboarding task${pendingTasks !== 1 ? "s" : ""} pending — complete them to finish your onboarding.`,
    content,
  });
}
