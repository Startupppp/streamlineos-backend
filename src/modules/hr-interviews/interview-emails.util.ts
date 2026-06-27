function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrap(title: string, body: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
      <div style="background: #0f2b7f; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: #fff; margin: 0; font-size: 20px;">${escapeHtml(title)}</h1>
      </div>
      <div style="padding: 24px; background: #fff; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        ${body}
      </div>
    </div>
  `;
}

interface InterviewInviteParams {
  recipientName: string;
  candidateName: string;
  jobTitle: string;
  companyName: string;
  scheduledAt: string;
  durationMinutes: number;
  format: string;
  meetingLink?: string;
  location?: string;
  notes?: string;
  recipientRole: "candidate" | "interviewer";
}

export function getInterviewInviteEmail(params: InterviewInviteParams): { subject: string; html: string } {
  const recipient = escapeHtml(params.recipientName);
  const candidate = escapeHtml(params.candidateName);
  const job = escapeHtml(params.jobTitle);
  const company = escapeHtml(params.companyName);
  const format = escapeHtml(params.format);
  const date = escapeHtml(params.scheduledAt);
  const meetLink = params.meetingLink ? escapeHtml(params.meetingLink) : null;
  const location = params.location ? escapeHtml(params.location) : null;
  const notes = params.notes ? escapeHtml(params.notes) : null;

  const isCandidate = params.recipientRole === "candidate";
  const durationLabel =
    params.durationMinutes >= 60 ? `${params.durationMinutes / 60}h` : `${params.durationMinutes}min`;

  const rows = [
    isCandidate ? "" : `<p><strong>Candidate:</strong> ${candidate}</p>`,
    `<p><strong>Position:</strong> ${job}</p>`,
    `<p><strong>Date &amp; Time:</strong> ${date}</p>`,
    `<p><strong>Duration:</strong> ${durationLabel}</p>`,
    `<p><strong>Format:</strong> ${format}</p>`,
    meetLink ? `<p><strong>Meeting Link:</strong> <a href="${meetLink}" style="color:#1e40af">${meetLink}</a></p>` : "",
    location ? `<p><strong>Location:</strong> ${location}</p>` : "",
  ].join("");

  const intro = isCandidate
    ? `We are pleased to invite you to interview for the <strong>${job}</strong> position at <strong>${company}</strong>.`
    : `You have been assigned as an interviewer for <strong>${candidate}</strong> applying for the <strong>${job}</strong> role.`;

  const closing = isCandidate
    ? "Please confirm your availability. If you need to reschedule, contact HR as soon as possible."
    : "Please review the candidate's profile and prepare your evaluation criteria before the interview.";

  const body = `
    <p>Dear ${recipient},</p>
    <p>${intro}</p>
    <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0;">${rows}</div>
    ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ""}
    <p>${closing}</p>
  `;

  const subject = isCandidate
    ? `Interview Invitation — ${job} at ${company}`
    : `Interview Assigned: ${candidate} — ${job}`;

  return { subject, html: wrap(isCandidate ? "Interview Invitation" : "Interview Assigned", body) };
}

export function getSelfScheduleBookingEmail(
  candidateName: string,
  bookingUrl: string,
  expiresAtLabel: string,
): { subject: string; html: string } {
  const name = escapeHtml(candidateName);
  const url = escapeHtml(bookingUrl);
  const expires = escapeHtml(expiresAtLabel);

  const body = `
    <p>Dear ${name},</p>
    <p>We'd like to invite you to schedule your interview at a time that works best for you.</p>
    <p>Please click the button below to select from the available time slots:</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${url}" style="display:inline-block;padding:12px 32px;background:#0f2b7f;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Choose a Time Slot</a>
    </div>
    <p style="font-size:13px;color:#6b7280;">This link expires on ${expires}.</p>
    <p>Best regards,<br/><strong>StreamlineOS Recruitment Team</strong></p>
  `;

  return { subject: "Schedule Your Interview — StreamlineOS", html: wrap("Schedule Your Interview", body) };
}

export function getBookingConfirmationEmail(
  candidateName: string,
  slotLabel: string,
): { subject: string; html: string } {
  const name = escapeHtml(candidateName);
  const slot = escapeHtml(slotLabel);
  const body = `<p>${name} has scheduled their interview for <strong>${slot}</strong>.</p>`;
  return { subject: `Interview Self-Scheduled: ${name}`, html: wrap("Interview Self-Scheduled", body) };
}
