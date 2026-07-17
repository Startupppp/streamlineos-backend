import { EmailBase } from "./email-base";
import { appUrl } from "./app-url";
import { type EmailAttachment } from "./email.provider";
import {
  getVerificationEmailTemplate,
  getMagicLinkEmailTemplate,
  getWelcomeEmailTemplate,
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
import { getAccountDeactivationEmailTemplate, getEmailOtpTemplate } from "./templates/auth";
import {
  getWorkLogApprovedEmailTemplate,
  getWorkLogRejectedEmailTemplate,
  getOnboardingWelcomeEmailTemplate,
  getOnboardingTaskEmailTemplate,
} from "./templates/notifications-misc";

export abstract class EmailSendersBase extends EmailBase {
  sendVerificationEmail(email: string, token: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Verify your email address",
      html: getVerificationEmailTemplate(`${appUrl}/verify-email?token=${token}&email=${encodeURIComponent(email)}`),
    });
  }

  sendPasswordResetEmail(email: string, token: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Reset your password",
      html: getPasswordResetEmailTemplate(`${appUrl}/reset-password?token=${token}`),
    });
  }

  sendPasswordChangeConfirmationEmail(email: string, userName: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Your password was changed",
      html: getPasswordChangeConfirmationEmailTemplate(userName),
    });
  }

  sendAccountLockedEmail(email: string, name: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Your account is temporarily locked",
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
      subject: `You've been invited to join ${organizationName}`,
      html: getInvitationEmailTemplate(`${appUrl}/invitation/${token}`, organizationName, inviterName),
    });
  }

  sendWelcomeEmail(email: string, name: string, setupUrl: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Your StreamlineOS account is ready",
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
      subject: `Upcoming holiday: ${holidayName}`,
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
      subject: `Announcement: ${subject}`,
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
      subject: `Leave request from ${employeeName}`,
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
      subject: status === "APPROVED" ? "Your leave request was approved" : "Your leave request was rejected",
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
      subject: `Leave request cancelled by ${employeeName}`,
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
      subject: `Resignation submitted by ${employeeName}`,
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
      subject: "Your resignation has been accepted",
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
      subject: "Notice of employment termination",
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
      subject: "Onboarding complete",
      html: getOnboardingCompleteEmployeeEmailTemplate(employeeName),
    });
  }

  sendOnboardingCompleteHrEmail(email: string, hrName: string, employeeName: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `${employeeName} completed onboarding`,
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
      subject: "Performance review assigned",
      html: getReviewAssignedEmailTemplate(employeeName, reviewerName, periodStart, periodEnd),
    });
  }

  sendMagicLinkEmail(email: string, token: string): Promise<void> {
    const magicLink = `${appUrl}/magic-link?token=${token}`;
    return this.sendEmail({
      to: email,
      subject: "Your sign-in link",
      html: getMagicLinkEmailTemplate(magicLink),
    });
  }

  sendEmailOtpEmail(email: string, code: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Your sign-in code",
      html: getEmailOtpTemplate(code),
    });
  }

  sendAccountDeactivationEmail(email: string, employeeName: string, deactivatedBy: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Your account has been deactivated",
      html: getAccountDeactivationEmailTemplate(employeeName, deactivatedBy),
    });
  }

  sendWorkLogApprovedEmail(email: string, employeeName: string, date: string, approverName: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Your work log was approved",
      html: getWorkLogApprovedEmailTemplate(employeeName, date, approverName),
    });
  }

  sendWorkLogRejectedEmail(
    email: string,
    employeeName: string,
    date: string,
    approverName: string,
    reason?: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Your work log needs changes",
      html: getWorkLogRejectedEmailTemplate(employeeName, date, approverName, reason),
    });
  }

  sendOnboardingWelcomeEmail(
    email: string,
    employeeName: string,
    designation: string,
    joiningDate: string,
    taskCount: number,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Welcome to StreamlineOS",
      html: getOnboardingWelcomeEmailTemplate(employeeName, designation, joiningDate, taskCount),
    });
  }

  sendOnboardingTaskEmail(
    email: string,
    recipientName: string,
    employeeName: string,
    taskRole: string,
    taskCount: number,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Onboarding tasks assigned to you",
      html: getOnboardingTaskEmailTemplate(recipientName, employeeName, taskRole, taskCount),
    });
  }
}
