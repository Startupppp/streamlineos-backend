import { getEmailTemplate, escapeHtml } from "./base";
import { renderButton, renderKeyValueRows, renderCallout, renderBadge } from "./components";

export function getSignEnvelopeInvitationEmailTemplate(
  recipientName: string,
  senderName: string,
  envelopeTitle: string,
  message: string | undefined,
  signingUrl: string,
): string {
  const content = `<p class="email-text">Hi ${escapeHtml(recipientName)},</p>
<p class="email-text">${escapeHtml(senderName)} has sent you a document to review and sign: <strong>${escapeHtml(envelopeTitle)}</strong>.</p>
${message ? renderCallout(escapeHtml(message), "info") : ""}
${renderButton("Review & sign", signingUrl)}
<p class="email-text" style="margin-top:16px;color:#6b7280;font-size:13px;">You do not need an account to sign. This link is unique to you and will expire.</p>`;
  return getEmailTemplate({
    title: `${senderName} sent you a document to sign`,
    preheader: `Please review and sign "${envelopeTitle}"`,
    content,
  });
}

export function getSignReminderEmailTemplate(
  recipientName: string,
  senderName: string,
  envelopeTitle: string,
  signingUrl: string,
  daysRemaining: number | null,
): string {
  const content = `<p class="email-text">Hi ${escapeHtml(recipientName)},</p>
<p class="email-text">This is a reminder that <strong>${escapeHtml(envelopeTitle)}</strong> from ${escapeHtml(senderName)} is still waiting for your signature.</p>
${daysRemaining !== null ? renderCallout(`This request expires in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}.`, "warning") : ""}
${renderButton("Review & sign", signingUrl)}`;
  return getEmailTemplate({
    title: `Reminder: "${envelopeTitle}" needs your signature`,
    preheader: `${envelopeTitle} is still awaiting your signature`,
    content,
  });
}

export function getSignEnvelopeCompletedEmailTemplate(
  recipientName: string,
  envelopeTitle: string,
  downloadUrl: string,
): string {
  const content = `<p class="email-text">Hi ${escapeHtml(recipientName)},</p>
<p style="margin:0 0 16px 0;">${renderBadge("Completed", "success")}</p>
<p class="email-text">All parties have signed <strong>${escapeHtml(envelopeTitle)}</strong>. Your completed copy is ready.</p>
${renderButton("Download signed document", downloadUrl)}`;
  return getEmailTemplate({
    title: `"${envelopeTitle}" is fully signed`,
    preheader: `All signers have completed ${envelopeTitle}`,
    content,
  });
}

export function getSignEnvelopeDeclinedEmailTemplate(
  senderName: string,
  envelopeTitle: string,
  declinedByName: string,
  reason: string,
  envelopeUrl: string,
): string {
  const content = `<p class="email-text">Hi ${escapeHtml(senderName)},</p>
<p style="margin:0 0 16px 0;">${renderBadge("Declined", "danger")}</p>
<p class="email-text">${escapeHtml(declinedByName)} has declined to sign <strong>${escapeHtml(envelopeTitle)}</strong>.</p>
${renderCallout(escapeHtml(reason), "warning")}
${renderButton("View envelope", envelopeUrl)}`;
  return getEmailTemplate({
    title: `"${envelopeTitle}" was declined`,
    preheader: `${declinedByName} declined to sign`,
    content,
  });
}

export function getSignEnvelopeVoidedEmailTemplate(
  recipientName: string,
  envelopeTitle: string,
  reason: string,
): string {
  const content = `<p class="email-text">Hi ${escapeHtml(recipientName)},</p>
<p style="margin:0 0 16px 0;">${renderBadge("Voided", "danger")}</p>
<p class="email-text"><strong>${escapeHtml(envelopeTitle)}</strong> has been voided by the sender and no longer needs any action.</p>
${renderCallout(escapeHtml(reason), "info")}`;
  return getEmailTemplate({
    title: `"${envelopeTitle}" has been voided`,
    preheader: `This signing request is no longer active`,
    content,
  });
}

export function getSignBulkJobCompletedEmailTemplate(
  senderName: string,
  totalCount: number,
  successCount: number,
  failedCount: number,
  jobUrl: string,
): string {
  const content = `<p class="email-text">Hi ${escapeHtml(senderName)},</p>
<p class="email-text">Your bulk send job has finished processing.</p>
${renderKeyValueRows([
  { label: "Total rows", value: String(totalCount) },
  { label: "Envelopes sent", value: String(successCount) },
  { label: "Failed rows", value: String(failedCount) },
])}
${renderButton("View job report", jobUrl)}`;
  return getEmailTemplate({
    title: "Bulk send job completed",
    preheader: `${successCount}/${totalCount} envelopes sent successfully`,
    content,
  });
}
