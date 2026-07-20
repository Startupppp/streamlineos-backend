import { EMAIL_THEME, getBrandName } from "../branding";
import { getEmailTemplate, appUrl, escapeHtml } from "./base";
import { renderButton, renderCallout, renderFallbackLink, renderKeyValueRows } from "./components";

export function getInvitationEmailTemplate(
  invitationUrl: string,
  organizationName: string,
  inviterName?: string,
): string {
  const brand = getBrandName();
  const safeOrgName = escapeHtml(organizationName);
  const safeInviter = inviterName ? escapeHtml(inviterName) : undefined;
  const intro = safeInviter
    ? `<strong>${safeInviter}</strong> invited you to join the <strong>${safeOrgName}</strong> workspace.`
    : `You&apos;ve been invited to join the <strong>${safeOrgName}</strong> workspace.`;
  const preheader = safeInviter
    ? `${safeInviter} invited you to join ${safeOrgName}`
    : `You've been invited to join ${safeOrgName}`;

  const content = `
    <p class="email-label">Workspace invitation</p>
    <h1 class="email-title">Join ${safeOrgName}</h1>
    <p class="email-text">
      ${intro} Accept below to create your account and get started.
    </p>
    ${renderButton("Accept invitation", invitationUrl)}
    ${renderCallout("This invitation expires in 7 days. If you weren&apos;t expecting it, you can safely ignore this email.")}
    ${renderFallbackLink(invitationUrl)}
  `;

  return getEmailTemplate({
    title: `Join ${safeOrgName} on ${escapeHtml(brand)}`,
    preheader,
    content,
  });
}

export function getHolidayAnnouncementEmailTemplate(
  holidayName: string,
  holidayDate: string,
  message?: string,
): string {
  const safeHolidayName = escapeHtml(holidayName);
  const safeHolidayDate = escapeHtml(holidayDate);
  const kvRows = renderKeyValueRows([
    { label: "Holiday", value: holidayName },
    { label: "Date", value: holidayDate },
  ]);
  const messageCallout = message ? renderCallout(escapeHtml(message)) : "";

  const content = `
    <p class="email-label">Company holiday</p>
    <h1 class="email-title">${safeHolidayName}</h1>
    <p class="email-text">
      The office will be closed on ${safeHolidayDate} for ${safeHolidayName}.
    </p>
    ${kvRows}
    ${messageCallout}
  `;

  return getEmailTemplate({
    title: `Upcoming holiday: ${safeHolidayName}`,
    preheader: `The office will be closed on ${safeHolidayDate} for ${safeHolidayName}.`,
    content,
  });
}

export function getCompanyAnnouncementEmailTemplate(
  subject: string,
  message: string,
  announcedBy: string,
): string {
  const brand = getBrandName();
  const safeSubject = escapeHtml(subject);
  const safeAnnouncedBy = escapeHtml(announcedBy);
  const safeMessage = escapeHtml(message).replace(/\n/g, "<br>");
  const postedDate = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const content = `
    <p class="email-label">Announcement</p>
    <h1 class="email-title">${safeSubject}</h1>
    <p class="email-text">
      ${safeMessage}
    </p>
    <p class="email-text" style="font-size:13px;color:${EMAIL_THEME.textMuted};margin:0 0 4px 0;">
      Posted by <strong style="color:${EMAIL_THEME.textStrong};">${safeAnnouncedBy}</strong> on ${postedDate}
    </p>
    ${renderButton(`Open ${brand}`, `${appUrl}/dashboard`)}
  `;

  return getEmailTemplate({
    title: `Announcement: ${safeSubject}`,
    preheader: safeSubject,
    content,
  });
}
