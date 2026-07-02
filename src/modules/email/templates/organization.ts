import { getEmailTemplate, appUrl, escapeHtml } from "./base";
import { renderButton, renderCallout, renderFallbackLink, renderKeyValueRows } from "./components";

export function getInvitationEmailTemplate(
  invitationUrl: string,
  organizationName: string,
  inviterName?: string,
): string {
  const safeOrgName = escapeHtml(organizationName);
  const intro = inviterName
    ? `<strong>${escapeHtml(inviterName)}</strong> has invited you to join <strong>${safeOrgName}</strong> on StreamlineOS.`
    : `You have been invited to join <strong>${safeOrgName}</strong> on StreamlineOS.`;
  const preheaderInviter = inviterName
    ? `${escapeHtml(inviterName)} invited you to join`
    : "You have been invited to join";

  const content = `
    <h1 class="email-title">You&#39;ve been invited to join ${safeOrgName}</h1>
    <p class="email-text">
      ${intro}
    </p>
    ${renderButton("Accept invitation", invitationUrl)}
    ${renderCallout("This invitation expires in 7 days. If you do not recognise this organisation, you can safely ignore this email.")}
    ${renderFallbackLink(invitationUrl)}
  `;

  return getEmailTemplate({
    title: `You've been invited to join ${safeOrgName}`,
    preheader: `${preheaderInviter} ${safeOrgName} on StreamlineOS.`,
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
    <h1 class="email-title">Upcoming holiday: ${safeHolidayName}</h1>
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
  const safeSubject = escapeHtml(subject);
  const safeAnnouncedBy = escapeHtml(announcedBy);
  const safeMessage = escapeHtml(message).replace(/\n/g, "<br>");
  const postedDate = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const content = `
    <h1 class="email-title">Announcement: ${safeSubject}</h1>
    <p class="email-text">
      ${safeMessage}
    </p>
    <p class="email-text" style="font-size:14px;color:#64748b;">
      Posted by <strong>${safeAnnouncedBy}</strong> on ${postedDate}
    </p>
    ${renderButton("Open StreamlineOS", `${appUrl}/dashboard`)}
  `;

  return getEmailTemplate({
    title: `Announcement: ${safeSubject}`,
    preheader: safeSubject,
    content,
  });
}
