import { getBrandName, getSupportEmail } from "../branding";
import { escapeHtml, getEmailTemplate } from "./base";
import { renderButton, renderCallout, renderKeyValueRows } from "./components";

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
  const notes = params.notes ? escapeHtml(params.notes) : null;

  const isCandidate = params.recipientRole === "candidate";

  const scheduledAtFormatted = /^\d{4}-\d{2}-\d{2}T/.test(params.scheduledAt)
    ? new Date(params.scheduledAt).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "long",
        timeStyle: "short",
      })
    : params.scheduledAt;

  const durationLabel =
    params.durationMinutes >= 60
      ? `${params.durationMinutes / 60}h`
      : `${params.durationMinutes}min`;

  const rows = [
    ...(isCandidate ? [] : [{ label: "Candidate", value: params.candidateName }]),
    { label: "Position", value: params.jobTitle },
    { label: "Date & time", value: scheduledAtFormatted },
    { label: "Duration", value: durationLabel },
    { label: "Format", value: params.format },
    ...(params.location ? [{ label: "Location", value: params.location }] : []),
  ];

  const intro = isCandidate
    ? `You have been invited to interview for the ${job} position at ${company}.`
    : `You have been assigned to interview ${candidate} for the ${job} role at ${company}.`;

  const closing = isCandidate
    ? "Please confirm your availability. Contact HR if you need to reschedule."
    : "Review the candidate's profile before the interview.";

  const cta = params.meetingLink ? renderButton("Join meeting", escapeHtml(params.meetingLink)) : "";

  const title = isCandidate ? "Interview invitation" : "Interview assigned";

  const content = `<h1 class="email-title">${title}</h1>
<p class="email-text">Hi ${recipient},</p>
<p class="email-text">${intro}</p>
${renderKeyValueRows(rows)}
${notes ? renderCallout(notes, "info") : ""}
<p class="email-text">${closing}</p>
${cta}`;

  const subject = isCandidate
    ? `Interview invitation â€” ${params.jobTitle} at ${params.companyName}`
    : `You're interviewing ${params.candidateName} on ${scheduledAtFormatted}`;

  return {
    subject,
    html: getEmailTemplate({
      title,
      preheader: isCandidate
        ? `Interview for ${params.jobTitle} at ${params.companyName} on ${scheduledAtFormatted}.`
        : `Interview with ${params.candidateName} on ${scheduledAtFormatted}.`,
      content,
    }),
  };
}

export function getSelfScheduleBookingEmail(
  candidateName: string,
  bookingUrl: string,
  expiresAtLabel: string,
  orgName = getBrandName(),
): { subject: string; html: string } {
  const name = escapeHtml(candidateName);
  const company = escapeHtml(orgName);

  const content = `<h1 class="email-title">Schedule your interview</h1>
<p class="email-text">Hi ${name},</p>
<p class="email-text">We would like to invite you to pick a time for your interview with ${company}. Choose a slot that works best for you.</p>
${renderButton("Choose a time", escapeHtml(bookingUrl))}
${renderCallout(`This scheduling link expires on ${escapeHtml(expiresAtLabel)}.`, "info")}`;

  return {
    subject: `Schedule your interview with ${orgName}`,
    html: getEmailTemplate({
      title: "Schedule your interview",
      preheader: `Pick a time for your interview with ${orgName}. Link expires ${expiresAtLabel}.`,
      content,
    }),
  };
}

export function getBookingConfirmationEmail(
  candidateName: string,
  slotLabel: string,
): { subject: string; html: string } {
  const rows = [
    { label: "Candidate", value: candidateName },
    { label: "Scheduled slot", value: slotLabel },
  ];

  const content = `<h1 class="email-title">Interview scheduled</h1>
<p class="email-text">The candidate has self-scheduled their interview.</p>
${renderKeyValueRows(rows)}`;

  return {
    subject: `${candidateName} scheduled their interview`,
    html: getEmailTemplate({
      title: "Interview scheduled",
      preheader: `${candidateName} selected a slot on ${slotLabel}.`,
      content,
    }),
  };
}

function feedbackRatingButton(ratingLabel: string, bgColor: string): string {
  const subject = encodeURIComponent(`Interview Feedback â€” ${ratingLabel}`);
  const body = encodeURIComponent(`Hi, I would rate my interview experience as ${ratingLabel}. (Add your comments here)`);
  const href = `mailto:${getSupportEmail()}?subject=${subject}&body=${body}`;
  return `<td style="padding:4px;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;background:${bgColor};color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">${escapeHtml(ratingLabel)}</a></td>`;
}

export function getCandidateFeedbackEmail(params: {
  candidateName: string;
  orgName: string;
  scheduledAt: Date;
}): { subject: string; html: string } {
  const name = escapeHtml(params.candidateName);
  const company = escapeHtml(params.orgName);
  const dateStr = escapeHtml(
    params.scheduledAt.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "long",
      timeStyle: "short",
    }),
  );

  const content = `<h1 class="email-title">Share your feedback</h1>
<p class="email-text">Hi ${name},</p>
<p class="email-text">Thank you for taking the time to interview with ${company} on ${dateStr}. Your feedback helps us improve our hiring process.</p>
${renderCallout("Was the process clear and respectful? Did you feel heard? Any suggestions?", "info")}
<p class="email-text" style="margin:0 0 12px 0;font-weight:600;">How would you rate your experience?</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px 0;"><tr>
${feedbackRatingButton("Excellent", "#16a34a")}
${feedbackRatingButton("Good", "#06b6d4")}
${feedbackRatingButton("Could be better", "#d97706")}
</tr></table>
<p class="email-text" style="font-size:13px;color:#64748B;">You can also reply to this email directly with any comments or suggestions.</p>`;

  return {
    subject: "How was your interview experience?",
    html: getEmailTemplate({
      title: "Share your feedback",
      preheader: `Let us know how your interview at ${params.orgName} went.`,
      content,
    }),
  };
}
