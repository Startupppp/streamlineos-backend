import { getEmailTemplate, escapeHtml } from "./base";
import { renderButton, renderKeyValueRows } from "./components";

export function getClientInvestmentEmailTemplate(params: {
  recipientName: string;
  clientName: string;
  amount: string;
  date: string;
  recordedBy: string;
  clientUrl: string;
}): { subject: string; html: string } {
  const { recipientName, clientName, amount, date, recordedBy, clientUrl } = params;
  const subject = `Investment recorded for ${clientName}`;
  const content = `
    <h1 class="email-title">Investment recorded</h1>
    <p class="email-text">Hi ${escapeHtml(recipientName)},</p>
    <p class="email-text">An investment has been recorded for ${escapeHtml(clientName)}.</p>
    ${renderKeyValueRows([
      { label: "Client", value: clientName },
      { label: "Amount", value: amount },
      { label: "Date", value: date },
      { label: "Recorded by", value: recordedBy },
    ])}
    ${renderButton("Open client", clientUrl)}
  `;
  return {
    subject,
    html: getEmailTemplate({
      title: subject,
      preheader: `${escapeHtml(clientName)} invested ${escapeHtml(amount)} on ${escapeHtml(date)}`,
      content,
    }),
  };
}

export function getLeadStatusChangeEmailTemplate(params: {
  recipientName: string;
  leadName: string;
  fromStatus: string | null;
  toStatus: string;
  leadUrl: string;
}): { subject: string; html: string } {
  const { recipientName, leadName, fromStatus, toStatus, leadUrl } = params;
  const subject = `Lead status updated: ${leadName}`;
  const rows: Array<{ label: string; value: string }> = [{ label: "Lead", value: leadName }];
  if (fromStatus) rows.push({ label: "From", value: fromStatus });
  rows.push({ label: "To", value: toStatus });
  const content = `
    <h1 class="email-title">Lead status updated</h1>
    <p class="email-text">Hi ${escapeHtml(recipientName)},</p>
    <p class="email-text">The status of ${escapeHtml(leadName)} has been updated.</p>
    ${renderKeyValueRows(rows)}
    ${renderButton("Open lead", leadUrl)}
  `;
  return {
    subject,
    html: getEmailTemplate({
      title: subject,
      preheader: fromStatus
        ? `${escapeHtml(leadName)} moved from ${escapeHtml(fromStatus)} to ${escapeHtml(toStatus)}`
        : `${escapeHtml(leadName)} is now ${escapeHtml(toStatus)}`,
      content,
    }),
  };
}

export function getLeadDistributionEmailTemplate(params: {
  recipientName: string;
  assignerName: string;
  leadCount: number;
  leadsUrl: string;
}): { subject: string; html: string } {
  const { recipientName, assignerName, leadCount, leadsUrl } = params;
  const plural = leadCount === 1 ? "" : "s";
  const subject = `${leadCount} lead${plural} assigned to you`;
  const content = `
    <h1 class="email-title">${leadCount} lead${plural} assigned</h1>
    <p class="email-text">Hi ${escapeHtml(recipientName)},</p>
    <p class="email-text">${escapeHtml(assignerName)} has assigned ${leadCount === 1 ? "a lead" : `${leadCount} leads`} to you.</p>
    ${renderKeyValueRows([
      { label: "Assigned by", value: assignerName },
      { label: "Lead count", value: String(leadCount) },
    ])}
    ${renderButton("View leads", leadsUrl)}
  `;
  return {
    subject,
    html: getEmailTemplate({
      title: subject,
      preheader: `${escapeHtml(assignerName)} has added ${leadCount} lead${plural} to your queue`,
      content,
    }),
  };
}
