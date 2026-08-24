import { getBrandName } from "../branding";
import { appUrl, escapeHtml, getEmailTemplate } from "./base";
import { renderButton, renderCallout, renderFallbackLink } from "./components";

export function getChatReplyReminderEmail(
  recipientName: string,
  senderName: string,
  messagePreview: string,
  channelLabel: string,
  channelId: number,
): string {
  const brand = getBrandName();
  const chatUrl = `${appUrl()}/chat?channel=${channelId}`;
  const preview = messagePreview.trim() || "Sent an attachment";
  const content = `<h1 class="email-title">${escapeHtml(senderName)} messaged you</h1>
<p class="email-text">Hi ${escapeHtml(recipientName)},</p>
<p class="email-text"><strong>${escapeHtml(senderName)}</strong> is waiting for your reply in <strong>${escapeHtml(channelLabel)}</strong>.</p>
${renderCallout(`&ldquo;${escapeHtml(preview.slice(0, 240))}${preview.length > 240 ? "…" : ""}&rdquo;`, "info")}
${renderButton(`Reply in ${brand}`, chatUrl)}
${renderFallbackLink(chatUrl)}
<p class="email-text" style="font-size:12px;color:#64748B;margin-top:20px;">You received this because you haven&apos;t replied within 15 minutes.</p>`;

  return getEmailTemplate({
    title: `${senderName} messaged you`,
    preheader: `${senderName} is waiting for your reply`,
    content,
  });
}
