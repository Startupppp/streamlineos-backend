function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface OfferDeadlineReminderParams {
  candidateName: string;
  orgName: string;
  designation: string | null;
  deadlineLabel: string;
  offerLink: string | null;
}

export function getOfferDeadlineReminderEmail(
  params: OfferDeadlineReminderParams,
): { subject: string; html: string } {
  const name = escapeHtml(params.candidateName);
  const company = escapeHtml(params.orgName);
  const deadline = escapeHtml(params.deadlineLabel);
  const designationRow = params.designation
    ? `<p><strong>Position:</strong> ${escapeHtml(params.designation)}</p>`
    : "";
  const reviewButton = params.offerLink
    ? `<div style="text-align:center;margin:24px 0">
         <a href="${escapeHtml(params.offerLink)}" style="display:inline-block;padding:12px 32px;background:#0f2b7f;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Review Your Offer</a>
       </div>`
    : "";

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#0f2b7f">Offer Acceptance Reminder</h2>
      <p>Dear ${name},</p>
      <p>This is a friendly reminder that your offer from <strong>${company}</strong> is awaiting your decision and the acceptance deadline is approaching.</p>
      ${designationRow}
      <p><strong>Deadline:</strong> ${deadline}</p>
      ${reviewButton}
      <p>Please review and respond before the deadline. If you have any questions, reach out to your HR contact.</p>
      <p style="color:#666;font-size:12px;margin-top:32px">This is an automated reminder from StreamlineOS HR system.</p>
    </div>
  `;

  return { subject: `Reminder: Your Offer from ${params.orgName} Expires Soon`, html };
}

export function getInterviewNoShowRescheduleEmail(
  candidateName: string,
  orgName: string,
): { subject: string; html: string } {
  const name = escapeHtml(candidateName);
  const company = escapeHtml(orgName);

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#0f2b7f">We missed you, ${name}!</h2>
      <p>We noticed you were unable to attend your recent interview with <strong>${company}</strong>.</p>
      <p>We understand things come up unexpectedly. If you're still interested in the opportunity, we'd be happy to reschedule at a time that works better for you.</p>
      <p>Please reply to this email or contact your recruiter to arrange a new time.</p>
      <p>Best regards,<br/><strong>${company} Talent Team</strong></p>
    </div>
  `;

  return { subject: `We missed you — Would you like to reschedule? | ${orgName}`, html };
}
