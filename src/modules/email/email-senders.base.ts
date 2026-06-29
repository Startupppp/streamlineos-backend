import { EmailBase } from "./email-base";
import { appUrl } from "./app-url";
import { type EmailAttachment } from "./email.provider";
import {
  getVerificationEmailTemplate,
  getPasswordResetEmailTemplate,
  getWelcomeEmailTemplate,
  getPasswordChangeConfirmationEmailTemplate,
  getAccountLockedEmailTemplate,
  getInvitationEmailTemplate,
  getHolidayAnnouncementEmailTemplate,
  getCompanyAnnouncementEmailTemplate,
  getLeaveRequestEmailTemplate,
  getLeaveStatusUpdateEmailTemplate,
  getLeaveCancellationEmailTemplate,
  getResignationSubmittedEmailTemplate,
  getResignationApprovedEmailTemplate,
  getTerminationEmailTemplate,
  getReviewAssignedEmailTemplate,
  getOnboardingCompleteEmployeeEmailTemplate,
  getOnboardingCompleteHrEmailTemplate,
} from "./templates";

export abstract class EmailSendersBase extends EmailBase {
  sendVerificationEmail(email: string, token: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Verify Your Email - StreamlineOS",
      html: getVerificationEmailTemplate(`${appUrl}/verify-email?token=${token}`),
    });
  }

  sendPasswordResetEmail(email: string, token: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Reset Your Password - StreamlineOS",
      html: getPasswordResetEmailTemplate(`${appUrl}/reset-password?token=${token}`),
    });
  }

  sendPasswordChangeConfirmationEmail(email: string, userName: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Password Changed Successfully - StreamlineOS",
      html: getPasswordChangeConfirmationEmailTemplate(userName),
    });
  }

  sendAccountLockedEmail(email: string, name: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Account Locked - StreamlineOS",
      html: getAccountLockedEmailTemplate(name),
    });
  }

  sendInvitationEmail(
    email: string,
    token: string,
    organizationName: string,
    inviterName?: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Invitation to join ${organizationName} - StreamlineOS`,
      html: getInvitationEmailTemplate(`${appUrl}/invitation/${token}`, organizationName, inviterName),
    });
  }

  sendWelcomeEmail(email: string, name: string, setupUrl: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Welcome to StreamlineOS — Set Up Your Account",
      html: getWelcomeEmailTemplate(name, email, setupUrl),
    });
  }

  sendHolidayAnnouncementEmail(
    email: string,
    holidayName: string,
    holidayDate: string,
    message?: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Holiday Tomorrow: ${holidayName} - StreamlineOS`,
      html: getHolidayAnnouncementEmailTemplate(holidayName, holidayDate, message),
    });
  }

  sendCompanyAnnouncementEmail(
    email: string,
    subject: string,
    message: string,
    announcedBy: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Announcement: ${subject} - StreamlineOS`,
      html: getCompanyAnnouncementEmailTemplate(subject, message, announcedBy),
    });
  }

  async sendBulkHolidayAnnouncement(
    emails: string[],
    holidayName: string,
    holidayDate: string,
    message?: string,
  ): Promise<void> {
    await Promise.allSettled(
      emails.map((email) => this.sendHolidayAnnouncementEmail(email, holidayName, holidayDate, message)),
    );
  }

  sendLeaveRequestEmail(
    email: string,
    approverName: string,
    employeeName: string,
    leaveType: string,
    startDate: string,
    endDate: string,
    reason: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Leave Request: ${employeeName} - StreamlineOS`,
      html: getLeaveRequestEmailTemplate(
        approverName,
        employeeName,
        leaveType,
        startDate,
        endDate,
        reason,
        `${appUrl}/hr/leaves`,
      ),
    });
  }

  sendLeaveStatusUpdateEmail(
    email: string,
    employeeName: string,
    leaveType: string,
    startDate: string,
    endDate: string,
    status: "APPROVED" | "REJECTED",
    approverName: string,
    rejectionReason?: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Leave Request ${status}: ${leaveType} - StreamlineOS`,
      html: getLeaveStatusUpdateEmailTemplate(
        employeeName,
        leaveType,
        startDate,
        endDate,
        status,
        approverName,
        rejectionReason,
      ),
    });
  }

  sendLeaveCancellationEmail(
    email: string,
    approverName: string,
    employeeName: string,
    leaveType: string,
    startDate: string,
    endDate: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Leave Cancelled: ${employeeName} - StreamlineOS`,
      html: getLeaveCancellationEmailTemplate(approverName, employeeName, leaveType, startDate, endDate),
    });
  }

  sendResignationSubmittedEmail(
    hrEmail: string,
    hrName: string,
    employeeName: string,
    employeeDesignation: string,
    submissionDate: string,
    lastWorkingDate: string,
    noticePeriodDays: number,
    reason: string,
  ): Promise<void> {
    return this.sendEmail({
      to: hrEmail,
      subject: `Resignation Submitted: ${employeeName} - StreamlineOS`,
      html: getResignationSubmittedEmailTemplate(
        hrName,
        employeeName,
        employeeDesignation,
        submissionDate,
        lastWorkingDate,
        noticePeriodDays,
        reason,
        `${appUrl}/hr/exit`,
      ),
    });
  }

  sendResignationApprovedEmail(
    employeeEmail: string,
    employeeName: string,
    approverName: string,
    lastWorkingDate: string,
    noticePeriodDays: number,
    submissionDate: string,
  ): Promise<void> {
    return this.sendEmail({
      to: employeeEmail,
      subject: `Resignation Accepted - StreamlineOS`,
      html: getResignationApprovedEmailTemplate(
        employeeName,
        approverName,
        lastWorkingDate,
        noticePeriodDays,
        submissionDate,
        `${appUrl}/hr/exit`,
      ),
    });
  }

  sendTerminationEmail(
    employeeEmail: string,
    employeeName: string,
    employeeDesignation: string,
    terminationDate: string,
    terminatedBy: string,
    reason: string,
    attachments?: EmailAttachment[],
  ): Promise<void> {
    return this.sendEmail({
      to: employeeEmail,
      subject: `Employment Termination Notice - StreamlineOS`,
      html: getTerminationEmailTemplate(
        employeeName,
        employeeDesignation,
        terminationDate,
        terminatedBy,
        reason,
        "hr@streamlineos.app",
      ),
      attachments,
    });
  }

  sendOnboardingCompleteEmployeeEmail(email: string, employeeName: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Onboarding Complete — Welcome to the Team!",
      html: getOnboardingCompleteEmployeeEmailTemplate(employeeName),
    });
  }

  sendOnboardingCompleteHrEmail(email: string, hrName: string, employeeName: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Onboarding Complete: ${employeeName}`,
      html: getOnboardingCompleteHrEmailTemplate(hrName, employeeName),
    });
  }

  sendReviewAssignedEmail(
    email: string,
    employeeName: string,
    reviewerName: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Performance Review Assigned — StreamlineOS",
      html: getReviewAssignedEmailTemplate(employeeName, reviewerName, periodStart, periodEnd),
    });
  }

  sendMagicLinkEmail(email: string, token: string): Promise<void> {
    const magicLink = `${appUrl}/magic-link?token=${token}`;
    return this.sendEmail({
      to: email,
      subject: "Your StreamlineOS sign-in link",
      html: `<p>Click the link below to sign in to StreamlineOS. This link expires in 1 hour and can only be used once.</p><p><a href="${magicLink}">${magicLink}</a></p>`,
    });
  }
}
