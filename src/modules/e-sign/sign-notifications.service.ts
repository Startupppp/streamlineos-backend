import { Injectable } from "@nestjs/common";
import { EmailService } from "../email/email.service";
import { appUrl } from "../email/app-url";
import { getEmailTemplate, escapeHtml } from "../email/templates/base";
import { renderButton } from "../email/templates/components";

@Injectable()
export class SignNotificationsService {
  constructor(private readonly email: EmailService) {}

  async sendCcNotice(email: string, name: string, envelopeTitle: string, envelopeViewUrl: string): Promise<void> {
    const html = getEmailTemplate({
      title: `You were copied on "${envelopeTitle}"`,
      preheader: `You've been added as a copy recipient on ${envelopeTitle}`,
      content: `<p class="email-text">Hi ${escapeHtml(name)},</p>
<p class="email-text">You've been copied on <strong>${escapeHtml(envelopeTitle)}</strong> for your records.</p>
${renderButton("View status", envelopeViewUrl)}`,
    });
    await this.email.sendEmail({ to: email, subject: `Copied on: ${envelopeTitle}`, html });
  }

  async sendOtpCode(email: string, name: string, code: string): Promise<void> {
    const html = getEmailTemplate({
      title: "Your one-time signing code",
      preheader: `Your code is ${code}`,
      content: `<p class="email-text">Hi ${escapeHtml(name)},</p>
<p class="email-text">Use this one-time code to continue signing. It expires in 10 minutes.</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:16px 0;">${escapeHtml(code)}</p>`,
    });
    await this.email.sendEmail({ to: email, subject: `Your signing code: ${code}`, html });
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
