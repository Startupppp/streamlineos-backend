import { getEmailTemplate, escapeHtml } from "./base";

export function getInvitationEmailTemplate(invitationUrl: string, organizationName: string, inviterName?: string): string {
  const safeOrgName = escapeHtml(organizationName);
  const safeInviterName = inviterName ? escapeHtml(inviterName) : undefined;
  const content = `
    <h2 class="email-title">🎉 You're Invited!</h2>
    <p class="email-text">
      ${safeInviterName ? `<strong>${safeInviterName}</strong> has invited you` : 'You have been invited'}
      to join <strong>${safeOrgName}</strong> on StreamlineOS.
    </p>

    <p class="email-text">
      Join your team to collaborate on projects, track attendance, manage HR operations, and more.
    </p>

    <div style="text-align: center;">
      <a href="${invitationUrl}" class="email-button">
        Accept Invitation
      </a>
    </div>

    <p class="email-text" style="font-size: 14px; color: #64748b; margin-top: 24px;">
      If the button doesn't work, you can copy and paste this link into your browser:
    </p>
    <p class="email-text" style="word-break: break-all; font-size: 13px; color: #0f2b7f;">
      ${invitationUrl}
    </p>

    <div class="divider"></div>

    <div class="security-notice">
      <p class="security-text">
        <strong>Note:</strong> This invitation will expire in 7 days.
        If you don't recognize this organization, you can safely ignore this email.
      </p>
    </div>
  `;

  return getEmailTemplate({
    title: `Invitation to join ${safeOrgName} - StreamlineOS`,
    preheader: `You've been invited to join ${safeOrgName}`,
    content,
  });
}

export function getHolidayAnnouncementEmailTemplate(
  holidayName: string,
  holidayDate: string,
  message?: string
): string {
  const safeName = escapeHtml(holidayName);
  const safeDate = escapeHtml(holidayDate);
  const safeMessage = message ? escapeHtml(message) : undefined;
  const content = `
    <h2 class="email-title">🎉 Upcoming Holiday: ${safeName}</h2>
    <p class="email-text">
      Dear Team,
    </p>

    <p class="email-text">
      This is a friendly reminder that <strong>${safeName}</strong> is tomorrow, <strong>${safeDate}</strong>.
    </p>

    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Holiday:</span>
        <span class="credential-value">${safeName}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Date:</span>
        <span class="credential-value">${safeDate}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Status:</span>
        <span style="color: #22c55e; font-weight: 700; margin-left: 8px;">OFFICE CLOSED</span>
      </div>
    </div>

    ${safeMessage ? `
    <div style="background: #f0fdf4; border-left: 4px solid #22c55e; padding: 16px; margin: 24px 0; border-radius: 4px;">
      <p style="margin: 0 0 8px 0; font-weight: 600; color: #166534; font-size: 14px;">💬 Message:</p>
      <p style="margin: 0; color: #15803d; font-size: 14px; line-height: 1.6;">${safeMessage}</p>
    </div>
    ` : ''}

    <p class="email-text">
      Please ensure all urgent tasks are completed before the end of today. The office will resume normal operations the following working day.
    </p>

    <div class="divider"></div>

    <p class="email-text">
      Wishing you and your family a wonderful ${safeName}! 🎊
    </p>
  `;

  return getEmailTemplate({
    title: `Holiday Tomorrow: ${safeName} - StreamlineOS`,
    preheader: `Office closed tomorrow for ${safeName}`,
    content,
  });
}

export function getCompanyAnnouncementEmailTemplate(
  subject: string,
  message: string,
  announcedBy: string
): string {
  const safeSubject = escapeHtml(subject);
  const safeMessage = escapeHtml(message);
  const safeAnnouncedBy = escapeHtml(announcedBy);
  const content = `
    <h2 class="email-title">📢 Company Announcement</h2>
    <p class="email-text">
      Dear Team,
    </p>

    <p class="email-text">
      <strong>${safeAnnouncedBy}</strong> has shared an important announcement:
    </p>

    <div class="credential-box">
      <h3 style="margin: 0 0 16px 0; color: #0f172a; font-size: 18px;">${safeSubject}</h3>
      <div style="color: #475569; font-size: 15px; line-height: 1.7; white-space: pre-wrap;">${safeMessage}</div>
    </div>

    <div class="divider"></div>

    <p class="email-text" style="font-size: 14px; color: #64748b;">
      For any questions or clarifications, please reach out to your manager or HR.
    </p>
  `;

  return getEmailTemplate({
    title: `Announcement: ${safeSubject} - StreamlineOS`,
    preheader: safeSubject,
    content,
  });
}
