import { Injectable } from "@nestjs/common";
import { type EmailOptions } from "./email.provider";
import { EmailService } from "./email.service";
import {
  getSignEnvelopeInvitationEmailTemplate,
  getSignReminderEmailTemplate,
  getSignEnvelopeCompletedEmailTemplate,
  getSignEnvelopeDeclinedEmailTemplate,
  getSignEnvelopeVoidedEmailTemplate,
  getSignBulkJobCompletedEmailTemplate,
} from "./templates";

@Injectable()
export class EmailSignService {
  constructor(private readonly email: EmailService) {}

  sendEmail(options: EmailOptions): Promise<void> {
    return this.email.sendEmail(options);
  }

  sendSignEnvelopeInvitationEmail(
    email: string,
    recipientName: string,
    senderName: string,
    envelopeTitle: string,
    message: string | undefined,
    signingUrl: string,
  ): Promise<void> {
    return this.email.sendEmail({
      to: email,
      subject: `${senderName} sent you a document to sign: ${envelopeTitle}`,
      html: getSignEnvelopeInvitationEmailTemplate(recipientName, senderName, envelopeTitle, message, signingUrl),
    });
  }

  sendSignReminderEmail(
    email: string,
    recipientName: string,
    senderName: string,
    envelopeTitle: string,
    signingUrl: string,
    daysRemaining: number | null,
  ): Promise<void> {
    return this.email.sendEmail({
      to: email,
      subject: `Reminder: "${envelopeTitle}" needs your signature`,
      html: getSignReminderEmailTemplate(recipientName, senderName, envelopeTitle, signingUrl, daysRemaining),
    });
  }

  sendSignEnvelopeCompletedEmail(
    email: string,
    recipientName: string,
    envelopeTitle: string,
    downloadUrl: string,
  ): Promise<void> {
    return this.email.sendEmail({
      to: email,
      subject: `"${envelopeTitle}" is fully signed`,
      html: getSignEnvelopeCompletedEmailTemplate(recipientName, envelopeTitle, downloadUrl),
    });
  }

  sendSignEnvelopeDeclinedEmail(
    email: string,
    senderName: string,
    envelopeTitle: string,
    declinedByName: string,
    reason: string,
    envelopeUrl: string,
  ): Promise<void> {
    return this.email.sendEmail({
      to: email,
      subject: `"${envelopeTitle}" was declined`,
      html: getSignEnvelopeDeclinedEmailTemplate(senderName, envelopeTitle, declinedByName, reason, envelopeUrl),
    });
  }

  sendSignEnvelopeVoidedEmail(
    email: string,
    recipientName: string,
    envelopeTitle: string,
    reason: string,
  ): Promise<void> {
    return this.email.sendEmail({
      to: email,
      subject: `"${envelopeTitle}" has been voided`,
      html: getSignEnvelopeVoidedEmailTemplate(recipientName, envelopeTitle, reason),
    });
  }

  sendSignBulkJobCompletedEmail(
    email: string,
    senderName: string,
    totalCount: number,
    successCount: number,
    failedCount: number,
    jobUrl: string,
  ): Promise<void> {
    return this.email.sendEmail({
      to: email,
      subject: "Bulk send job completed",
      html: getSignBulkJobCompletedEmailTemplate(senderName, totalCount, successCount, failedCount, jobUrl),
    });
  }
}
