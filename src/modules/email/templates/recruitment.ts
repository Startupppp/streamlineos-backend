import { escapeHtml, getEmailTemplate } from "./base";
import { renderButton, renderCallout, renderKeyValueRows } from "./components";

interface RejectionEmailParams {
  candidateName: string;
  jobTitle: string;
  companyName: string;
  senderName?: string;
  notes?: string;
}

export function getCandidateRejectionEmail(params: RejectionEmailParams): { subject: string; html: string } {
  const name = escapeHtml(params.candidateName);
  const jobTitle = escapeHtml(params.jobTitle);
  const company = escapeHtml(params.companyName);
  const notes = params.notes ? escapeHtml(params.notes) : null;

  const content = `<h1 class="email-title">Application update</h1>
<p class="email-text">Hi ${name},</p>
<p class="email-text">Thank you for applying for the ${jobTitle} role at ${company}. We appreciate the time you invested in the process.</p>
<p class="email-text">After careful consideration, we will not be moving forward with your application at this time. We hope you will consider applying for future openings that match your background.</p>
${notes ? `<p class="email-text">${notes}</p>` : ""}`;

  return {
    subject: `Update on your application to ${params.companyName}`,
    html: getEmailTemplate({
      title: "Application update",
      preheader: `An update on your ${params.jobTitle} application at ${params.companyName}.`,
      content,
    }),
  };
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
  const org = escapeHtml(params.orgName);

  const rows = [
    ...(params.designation ? [{ label: "Position", value: params.designation }] : []),
    { label: "Offer expires", value: params.deadlineLabel },
  ];

  const cta = params.offerLink ? renderButton("Review offer", escapeHtml(params.offerLink)) : "";

  const content = `<h1 class="email-title">Offer deadline reminder</h1>
<p class="email-text">Hi ${name},</p>
<p class="email-text">Your offer from ${org} is awaiting your decision.</p>
${renderKeyValueRows(rows)}
${renderCallout(`Your offer expires on ${escapeHtml(params.deadlineLabel)}. Review and respond before the deadline to secure this opportunity.`, "warning")}
${cta}`;

  return {
    subject: `Reminder: your offer expires on ${params.deadlineLabel}`,
    html: getEmailTemplate({
      title: "Offer deadline reminder",
      preheader: `Your offer from ${params.orgName} expires on ${params.deadlineLabel}.`,
      content,
    }),
  };
}

export function getInterviewNoShowRescheduleEmail(
  candidateName: string,
  orgName: string,
): { subject: string; html: string } {
  const name = escapeHtml(candidateName);
  const company = escapeHtml(orgName);

  const content = `<h1 class="email-title">Let's reschedule</h1>
<p class="email-text">Hi ${name},</p>
<p class="email-text">We missed you at your recently scheduled interview with ${company}. We understand that things come up unexpectedly.</p>
<p class="email-text">If you are still interested in the role, reply to this email or contact your recruiter to arrange a new time.</p>`;

  return {
    subject: "Let's reschedule your interview",
    html: getEmailTemplate({
      title: "Let's reschedule",
      preheader: "We missed you at your interview — reply to arrange a new time.",
      content,
    }),
  };
}

interface CandidateDocumentRolloutParams {
  candidateName: string;
  documentLinks: Array<{ title: string; url: string }>;
}

export function getCandidateDocumentRolloutEmail(
  params: CandidateDocumentRolloutParams,
): { subject: string; html: string } {
  const name = escapeHtml(params.candidateName);
  const linksHtml = params.documentLinks
    .map((doc) => `<li style="margin-bottom:8px;"><a href="${escapeHtml(doc.url)}" style="color:#1e40af;text-decoration:none;font-weight:500;">${escapeHtml(doc.title)}</a></li>`)
    .join("");

  const content = `
    <p class="email-text">Hi ${name},</p>
    <p class="email-text">The following document${params.documentLinks.length !== 1 ? "s have" : " has"} been prepared for you as part of your application process. Please review and sign them before the application deadline.</p>
    <ul style="margin:16px 0;padding-left:24px;font-family:'DM Sans',-apple-system,sans-serif;font-size:15px;line-height:1.7;color:#4A5568;">
      ${linksHtml}
    </ul>
    ${renderButton("View documents", params.documentLinks[0] ? escapeHtml(params.documentLinks[0].url) : "")}
  `;

  return {
    subject: "Your documents are ready — please review",
    html: getEmailTemplate({
      title: "Your documents are ready",
      preheader: `${params.documentLinks.length} document${params.documentLinks.length !== 1 ? "s" : ""} prepared for your review — please sign before the application deadline.`,
      content,
    }),
  };
}
