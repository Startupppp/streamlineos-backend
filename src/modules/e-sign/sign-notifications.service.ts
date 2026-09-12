import { Injectable } from "@nestjs/common";
import { EmailSignService } from "../email/email-sign.service";
import { appUrl } from "../email/app-url";
import { getEmailTemplate, escapeHtml } from "../email/templates/base";
import { renderButton } from "../email/templates/components";

@Injectable()
export class SignNotificationsService {
  constructor(private readonly email: EmailSignService) {}

  private ccNoticeOptions(email: string, name: string, envelopeTitle: string, envelopeViewUrl: string) {
    const html = getEmailTemplate({
      title: `You were copied on "${envelopeTitle}"`,
      preheader: `You've been added as a copy recipient on ${envelopeTitle}`,
      content: `<p class="email-text">Hi ${escapeHtml(name)},</p>
<p class="email-text">You've been copied on <strong>${escapeHtml(envelopeTitle)}</strong> for your records.</p>
${renderButton("View status", envelopeViewUrl)}`,
    });
    return { to: email, subject: `Copied on: ${envelopeTitle}`, html };
  }

  async sendCcNotice(email: string, name: string, envelopeTitle: string, envelopeViewUrl: string): Promise<void> {
    await this.email.sendEmail(this.ccNoticeOptions(email, name, envelopeTitle, envelopeViewUrl));
  }

  /** The CC notice as an outbox row only; see `queueInvitation`. */
  async queueCcNotice(email: string, name: string, envelopeTitle: string, envelopeViewUrl: string): Promise<void> {
    await this.email.sendEmail(this.ccNoticeOptions(email, name, envelopeTitle, envelopeViewUrl));
  }

  /**
   * The code stays out of the subject and the preheader.
   *
   * Both were carrying it. A subject line is the most widely exposed part of an
   * email: it renders on a locked phone, sits in every mail-client list view
   * over the recipient's shoulder, and is recorded far more casually than a body
   * by relays and archivers. The preheader is the same text one line down — it
   * is what a client shows as the preview snippet, which is exactly the
   * lock-screen surface.
   *
   * The code is a second factor for signing a document. Putting it where the
   * envelope's own notification already appears defeats most of what it is for,
   * and costs nothing to move: the body is behind the same click that opening
   * the mail requires anyway.
   */
  async sendOtpCode(email: string, name: string, code: string): Promise<void> {
    const html = getEmailTemplate({
      title: "Your one-time signing code",
      preheader: "Open this message for the one-time code you were asked for.",
      content: `<p class="email-text">Hi ${escapeHtml(name)},</p>
<p class="email-text">Use this one-time code to continue signing. It expires in 10 minutes.</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:16px 0;">${escapeHtml(code)}</p>
<p class="email-text">If you did not ask to sign anything, ignore this message — the code is useless without the signing link.</p>`,
    });
    await this.email.sendEmail({
      to: email,
      subject: "Your one-time signing code",
      html,
    });
  }

  async sendInvitation(
    recipientEmail: string,
    recipientName: string,
    senderName: string,
    envelopeTitle: string,
    message: string | undefined,
    signingUrl: string,
  ): Promise<void> {
    await this.email.sendSignEnvelopeInvitationEmail(
      recipientEmail,
      recipientName,
      senderName,
      envelopeTitle,
      message,
      signingUrl,
    );
  }

  /**
   * The invitation as an outbox row only, written inside the caller's
   * transaction. The outbox cron delivers it; nothing is attempted here.
   */
  async queueInvitation(
    recipientEmail: string,
    recipientName: string,
    senderName: string,
    envelopeTitle: string,
    message: string | undefined,
    signingUrl: string,
  ): Promise<void> {
    await this.email.sendSignEnvelopeInvitationEmail(
      recipientEmail,
      recipientName,
      senderName,
      envelopeTitle,
      message,
      signingUrl,
    );
  }

  async sendReminder(
    recipientEmail: string,
    recipientName: string,
    senderName: string,
    envelopeTitle: string,
    signingUrl: string,
    daysRemaining: number | null,
  ): Promise<void> {
    await this.email.sendSignReminderEmail(
      recipientEmail,
      recipientName,
      senderName,
      envelopeTitle,
      signingUrl,
      daysRemaining,
    );
  }

  async sendCompletedToRecipient(recipientEmail: string, recipientName: string, envelopeId: number, envelopeTitle: string): Promise<void> {
    await this.email.sendSignEnvelopeCompletedEmail(
      recipientEmail,
      recipientName,
      envelopeTitle,
      `${appUrl()}/sign/envelopes/${envelopeId}/final-pdf`,
    );
  }

  async sendDeclinedToSender(
    senderEmail: string,
    senderName: string,
    envelopeId: number,
    envelopeTitle: string,
    declinedByName: string,
    reason: string,
  ): Promise<void> {
    await this.email.sendSignEnvelopeDeclinedEmail(
      senderEmail,
      senderName,
      envelopeTitle,
      declinedByName,
      reason,
      `${appUrl()}/sign/envelopes/${envelopeId}`,
    );
  }

  async sendVoidedToRecipient(
    recipientEmail: string,
    recipientName: string,
    envelopeTitle: string,
    reason: string,
  ): Promise<void> {
    await this.email.sendSignEnvelopeVoidedEmail(recipientEmail, recipientName, envelopeTitle, reason);
  }

  async sendBulkJobCompleted(
    senderEmail: string,
    senderName: string,
    jobId: number,
    totalCount: number,
    successCount: number,
    failedCount: number,
  ): Promise<void> {
    await this.email.sendSignBulkJobCompletedEmail(
      senderEmail,
      senderName,
      totalCount,
      successCount,
      failedCount,
      `${appUrl()}/sign/bulk-send/${jobId}`,
    );
  }
}
