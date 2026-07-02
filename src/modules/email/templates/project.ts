import { getEmailTemplate, escapeHtml } from "./base";
import { renderButton, renderKeyValueRows, renderCallout, renderBadge } from "./components";
import type { Tone } from "./components";

function priorityTone(priority: string): Tone {
  if (priority === "URGENT" || priority === "HIGH") return "danger";
  if (priority === "MEDIUM") return "warning";
  return "info";
}

export function getProjectAssignmentEmailTemplate(
  memberName: string,
  projectName: string,
  projectKey: string,
  projectUrl: string,
  assignedBy?: string
): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Project", value: projectName },
    { label: "Project key", value: projectKey },
  ];
  if (assignedBy) {
    rows.push({ label: "Added by", value: assignedBy });
  }
  const content = `
    <p class="email-text">Hi ${escapeHtml(memberName)},</p>
    <p class="email-text">You have been added to <strong>${escapeHtml(projectName)}</strong>. Open the project to view tickets and collaborate with your team.</p>
    ${renderKeyValueRows(rows)}
    ${renderButton("Open project", projectUrl)}
  `;
  return getEmailTemplate({
    title: `Added to ${escapeHtml(projectName)}`,
    preheader: `You've been added to ${escapeHtml(projectName)}${assignedBy ? ` by ${escapeHtml(assignedBy)}` : ""}`,
    content,
  });
}

export function getTicketAssignmentEmailTemplate(
  assigneeName: string,
  ticketTitle: string,
  ticketType: string,
  ticketPriority: string,
  projectName: string,
  ticketUrl: string,
  createdBy: string
): string {
  const badge = renderBadge(ticketPriority, priorityTone(ticketPriority));
  const rows: Array<{ label: string; value: string }> = [
    { label: "Ticket", value: ticketTitle },
    { label: "Project", value: projectName },
    { label: "Type", value: ticketType },
  ];
  const content = `
    <p class="email-text">Hi ${escapeHtml(assigneeName)},</p>
    <p class="email-text">${escapeHtml(createdBy)} assigned a ticket to you. Priority: ${badge}</p>
    ${renderKeyValueRows(rows)}
    ${renderButton("Open ticket", ticketUrl)}
  `;
  return getEmailTemplate({
    title: `Ticket assigned: ${escapeHtml(ticketTitle)}`,
    preheader: `${escapeHtml(createdBy)} assigned you a ${escapeHtml(ticketPriority.toLowerCase())} priority ticket`,
    content,
  });
}

export function getTicketReviewRequestEmailTemplate(
  reviewerName: string,
  ticketTitle: string,
  ticketType: string,
  projectName: string,
  ticketUrl: string,
  completedBy: string,
  comment?: string
): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Ticket", value: ticketTitle },
    { label: "Project", value: projectName },
    { label: "Type", value: ticketType },
    { label: "Completed by", value: completedBy },
  ];
  const content = `
    <p class="email-text">Hi ${escapeHtml(reviewerName)},</p>
    <p class="email-text">${escapeHtml(completedBy)} completed work on a ticket and moved it to review.</p>
    ${renderKeyValueRows(rows)}
    ${comment ? renderCallout(escapeHtml(comment), "info") : ""}
    ${renderButton("Review ticket", ticketUrl)}
  `;
  return getEmailTemplate({
    title: `Ready for review: ${escapeHtml(ticketTitle)}`,
    preheader: `${escapeHtml(completedBy)} completed work on ${escapeHtml(ticketTitle)} — ready for review`,
    content,
  });
}

export function getTicketChangesRequestedEmailTemplate(
  assigneeName: string,
  ticketTitle: string,
  projectName: string,
  ticketUrl: string,
  reviewerName: string,
  comment?: string
): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Ticket", value: ticketTitle },
    { label: "Project", value: projectName },
    { label: "Reviewed by", value: reviewerName },
  ];
  const feedbackText = comment
    ? escapeHtml(comment)
    : `${escapeHtml(reviewerName)} has requested changes. Open the ticket to view the feedback and update your work.`;
  const content = `
    <p class="email-text">Hi ${escapeHtml(assigneeName)},</p>
    <p class="email-text">${escapeHtml(reviewerName)} reviewed your work and requested changes.</p>
    ${renderKeyValueRows(rows)}
    ${renderCallout(feedbackText, "warning")}
    ${renderButton("Open ticket", ticketUrl)}
  `;
  return getEmailTemplate({
    title: `Changes requested: ${escapeHtml(ticketTitle)}`,
    preheader: `${escapeHtml(reviewerName)} requested changes on ${escapeHtml(ticketTitle)}`,
    content,
  });
}
