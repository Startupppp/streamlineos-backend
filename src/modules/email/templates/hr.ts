import { getEmailTemplate, escapeHtml } from "./base";
import { renderButton, renderKeyValueRows, renderCallout, renderBadge } from "./components";

export function getLeaveRequestEmailTemplate(
  approverName: string,
  employeeName: string,
  leaveType: string,
  startDate: string,
  endDate: string,
  reason: string,
  leaveUrl: string
): string {
  const content = `<p class="email-text">Hi ${escapeHtml(approverName)},</p>
<p class="email-text">${escapeHtml(employeeName)} has submitted a leave request that requires your approval.</p>
${renderKeyValueRows([
  { label: "Employee", value: employeeName },
  { label: "Type", value: leaveType },
  { label: "From", value: startDate },
  { label: "To", value: endDate },
  { label: "Reason", value: reason },
])}
${renderButton("Review request", leaveUrl)}`;
  return getEmailTemplate({
    title: `Leave request from ${escapeHtml(employeeName)}`,
    preheader: `${escapeHtml(employeeName)} requested ${escapeHtml(leaveType)} from ${escapeHtml(startDate)} to ${escapeHtml(endDate)}.`,
    content,
  });
}

export function getLeaveStatusUpdateEmailTemplate(
  employeeName: string,
  leaveType: string,
  startDate: string,
  endDate: string,
  status: "APPROVED" | "REJECTED",
  approverName: string,
  rejectionReason?: string
): string {
  const isApproved = status === "APPROVED";
  const subject = isApproved ? "Your leave request was approved" : "Your leave request was rejected";
  const content = `<p class="email-text">Hi ${escapeHtml(employeeName)},</p>
<p class="email-text">Your leave request has been reviewed by ${escapeHtml(approverName)}.</p>
<p style="margin:0 0 16px 0;">${renderBadge(isApproved ? "Approved" : "Rejected", isApproved ? "success" : "danger")}</p>
${renderKeyValueRows([
  { label: "Type", value: leaveType },
  { label: "From", value: startDate },
  { label: "To", value: endDate },
  { label: "Reviewed by", value: approverName },
])}
${!isApproved && rejectionReason ? renderCallout(escapeHtml(rejectionReason), "warning") : ""}`;
  return getEmailTemplate({
    title: subject,
    preheader: `Your ${escapeHtml(leaveType)} leave from ${escapeHtml(startDate)} to ${escapeHtml(endDate)} was ${isApproved ? "approved" : "rejected"}.`,
    content,
  });
}

export function getLeaveCancellationEmailTemplate(
  approverName: string,
  employeeName: string,
  leaveType: string,
  startDate: string,
  endDate: string
): string {
  const content = `<p class="email-text">Hi ${escapeHtml(approverName)},</p>
<p class="email-text">${escapeHtml(employeeName)} has cancelled a leave request. No further action is needed.</p>
${renderKeyValueRows([
  { label: "Employee", value: employeeName },
  { label: "Type", value: leaveType },
  { label: "From", value: startDate },
  { label: "To", value: endDate },
])}`;
  return getEmailTemplate({
    title: `Leave request cancelled by ${escapeHtml(employeeName)}`,
    preheader: `${escapeHtml(employeeName)} cancelled their ${escapeHtml(leaveType)} from ${escapeHtml(startDate)} to ${escapeHtml(endDate)}.`,
    content,
  });
}

export function getResignationSubmittedEmailTemplate(
  hrName: string,
  employeeName: string,
  employeeDesignation: string,
  submissionDate: string,
  lastWorkingDate: string,
  noticePeriodDays: number,
  reason: string,
  reviewUrl: string
): string {
  const content = `<p class="email-text">Hi ${escapeHtml(hrName)},</p>
<p class="email-text">${escapeHtml(employeeName)} has submitted a resignation that requires your review.</p>
${renderKeyValueRows([
  { label: "Employee", value: employeeName },
  { label: "Designation", value: employeeDesignation },
  { label: "Notice date", value: submissionDate },
  { label: "Notice period", value: `${noticePeriodDays} days` },
  { label: "Last working day", value: lastWorkingDate },
  { label: "Reason", value: reason },
])}
${renderButton("Review resignation", reviewUrl)}`;
  return getEmailTemplate({
    title: `Resignation submitted by ${escapeHtml(employeeName)}`,
    preheader: `${escapeHtml(employeeName)} has resigned. Last working day: ${escapeHtml(lastWorkingDate)}.`,
    content,
  });
}

export function getResignationApprovedEmailTemplate(
  employeeName: string,
  approverName: string,
  lastWorkingDate: string,
  noticePeriodDays: number,
  submissionDate: string,
  portalUrl: string
): string {
  const content = `<p class="email-text">Hi ${escapeHtml(employeeName)},</p>
<p class="email-text">Your resignation submitted on ${escapeHtml(submissionDate)} has been accepted by ${escapeHtml(approverName)}.</p>
${renderKeyValueRows([
  { label: "Last working day", value: lastWorkingDate },
  { label: "Notice period", value: `${noticePeriodDays} days` },
])}
${renderCallout("Complete your handover before the last working day, return all company assets, and contact HR regarding your final settlement.", "info")}
${renderButton("View exit details", portalUrl)}`;
  return getEmailTemplate({
    title: "Your resignation has been accepted",
    preheader: `Your last working day is ${escapeHtml(lastWorkingDate)}. Complete your exit checklist before then.`,
    content,
  });
}

export function getTerminationEmailTemplate(
  employeeName: string,
  employeeDesignation: string,
  terminationDate: string,
  terminatedBy: string,
  reason: string,
  hrContactEmail: string
): string {
  const content = `<p class="email-text">Hi ${escapeHtml(employeeName)},</p>
<p class="email-text">This notice confirms that your employment with StreamlineOS has been terminated, effective the date below.</p>
${renderKeyValueRows([
  { label: "Designation", value: employeeDesignation },
  { label: "Effective date", value: terminationDate },
  { label: "Authorised by", value: terminatedBy },
  { label: "Reason", value: reason },
])}
${renderCallout(`For questions regarding your final settlement or exit formalities, contact HR at <a href="mailto:${escapeHtml(hrContactEmail)}" style="color:inherit;text-decoration:underline;">${escapeHtml(hrContactEmail)}</a>.`, "info")}`;
  return getEmailTemplate({
    title: "Notice of employment termination",
    preheader: `Your employment with StreamlineOS has been terminated, effective ${escapeHtml(terminationDate)}.`,
    content,
  });
}

export function getDocumentExpiryReminderEmailTemplate(
  employeeName: string,
  documentName: string,
  documentType: string,
  expiryDate: string,
  daysRemaining: number
): string {
  const content = `<p class="email-text">Hi ${escapeHtml(employeeName)},</p>
<p class="email-text">The following document is expiring soon and requires renewal to avoid compliance issues.</p>
${renderKeyValueRows([
  { label: "Document", value: documentName },
  { label: "Type", value: documentType },
  { label: "Expires on", value: expiryDate },
  { label: "Days remaining", value: `${daysRemaining}` },
])}
${renderCallout("Renew or update this document before the expiry date to maintain compliance.", "warning")}`;
  return getEmailTemplate({
    title: `Action needed: ${escapeHtml(documentName)} expires soon`,
    preheader: `${escapeHtml(documentName)} expires in ${daysRemaining} days. Update it before ${escapeHtml(expiryDate)}.`,
    content,
  });
}
