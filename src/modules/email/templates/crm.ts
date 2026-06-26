import { getEmailTemplate, escapeHtml } from "./base";

export function getLeadWelcomeEmail(
  leadName: string,
  orgName: string,
  contactEmail: string,
  websiteUrl?: string
): string {
  const sName = escapeHtml(leadName);
  const sOrg = escapeHtml(orgName);
  const content = `
    <h2 class="email-title">👋 Thank You for Your Interest</h2>
    <p class="email-text">Dear <strong>${sName}</strong>,</p>
    <p class="email-text">
      Thank you for reaching out to <strong>${sOrg}</strong>. We have received your inquiry and a member of our team will be in touch shortly.
    </p>
    <p class="email-text">
      In the meantime, feel free to reach us at
      <a href="mailto:${escapeHtml(contactEmail)}" style="color:#bd882c;">${escapeHtml(contactEmail)}</a>.
    </p>
    ${websiteUrl ? `<div style="text-align:center;margin:32px 0;"><a href="${escapeHtml(websiteUrl)}" class="email-button">Visit Our Website</a></div>` : ""}
  `;
  return getEmailTemplate({
    title: `Thank you for contacting ${orgName}`,
    preheader: `We received your inquiry and will be in touch soon`,
    content,
  });
}

export function getFollowUpReminderEmail(
  repName: string,
  leadName: string,
  daysSinceContact: number,
  leadUrl: string
): string {
  const sRep = escapeHtml(repName);
  const sLead = escapeHtml(leadName);
  const content = `
    <h2 class="email-title">⏰ Follow-Up Reminder</h2>
    <p class="email-text">Hi <strong>${sRep}</strong>,</p>
    <p class="email-text">
      You haven't contacted <strong>${sLead}</strong> in <strong>${daysSinceContact} days</strong>. A timely follow-up can significantly improve conversion rates.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${leadUrl}" class="email-button">View Lead</a>
    </div>
  `;
  return getEmailTemplate({
    title: `Follow up with ${leadName}`,
    preheader: `${leadName} hasn't been contacted in ${daysSinceContact} days`,
    content,
  });
}

export function getDealWonEmail(
  teamMemberName: string,
  dealName: string,
  dealValue: string,
  closedBy: string,
  dashboardUrl: string
): string {
  const sDeal = escapeHtml(dealName);
  const sClosedBy = escapeHtml(closedBy);
  const sName = escapeHtml(teamMemberName);
  const content = `
    <h2 class="email-title">🎉 Deal Won!</h2>
    <p class="email-text">Hi <strong>${sName}</strong>,</p>
    <p class="email-text">
      Great news! <strong>${sClosedBy}</strong> just closed the deal <strong>${sDeal}</strong> worth <strong>${escapeHtml(dealValue)}</strong>.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${dashboardUrl}" class="email-button">View Dashboard</a>
    </div>
  `;
  return getEmailTemplate({
    title: `Deal Won: ${dealName}`,
    preheader: `${dealName} closed! ${dealValue} added to revenue`,
    content,
  });
}

export function getSlaBreachAlertEmail(
  repName: string,
  leadName: string,
  hoursOverdue: number,
  leadUrl: string
): string {
  const sRep = escapeHtml(repName);
  const sLead = escapeHtml(leadName);
  const content = `
    <h2 class="email-title" style="color:#ef4444;">⚠️ SLA Breach Alert</h2>
    <p class="email-text">Hi <strong>${sRep}</strong>,</p>
    <p class="email-text">
      Lead <strong>${sLead}</strong> has breached its SLA by <strong>${hoursOverdue} hour${hoursOverdue !== 1 ? "s" : ""}</strong>. Immediate action is required.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${leadUrl}" class="email-button" style="background:#ef4444;">View Lead Now</a>
    </div>
  `;
  return getEmailTemplate({
    title: `SLA Breach: ${leadName}`,
    preheader: `${leadName} has breached SLA by ${hoursOverdue} hours`,
    content,
  });
}

export function getClientOnboardingEmail(
  clientName: string,
  orgName: string,
  contactName: string,
  portalUrl: string
): string {
  const sClient = escapeHtml(clientName);
  const sOrg = escapeHtml(orgName);
  const sContact = escapeHtml(contactName);
  const content = `
    <h2 class="email-title">🚀 Welcome to ${sOrg}!</h2>
    <p class="email-text">Dear <strong>${sClient}</strong>,</p>
    <p class="email-text">
      We are excited to welcome you as a client of <strong>${sOrg}</strong>. Your dedicated point of contact is <strong>${sContact}</strong>.
    </p>
    <p class="email-text">
      You can access your project updates and documents through our client portal.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${portalUrl}" class="email-button">Access Client Portal</a>
    </div>
  `;
  return getEmailTemplate({
    title: `Welcome to ${orgName}`,
    preheader: `Your onboarding with ${orgName} begins today`,
    content,
  });
}
