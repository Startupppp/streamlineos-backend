import { appUrl } from "./app-url";
import { getBrandName } from "./branding";
import { dispatchEmail, type EmailOptions } from "./email.provider";
import {
  getVerificationEmailTemplate,
  getMagicLinkEmailTemplate,
  getWelcomeEmailTemplate,
  getInvitationEmailTemplate,
  getInvitationRevokedEmailTemplate,
  getMembershipRemovedEmailTemplate,
  getMembershipSuspendedEmailTemplate,
  getHolidayAnnouncementEmailTemplate,
  getCompanyAnnouncementEmailTemplate,
  getLeaveRequestEmailTemplate,
  getLeaveStatusUpdateEmailTemplate,
  getLeaveCancellationEmailTemplate,
  getResignationSubmittedEmailTemplate,
  getResignationApprovedEmailTemplate,
  getReviewAssignedEmailTemplate,
  getOnboardingCompleteEmployeeEmailTemplate,
  getOnboardingCompleteHrEmailTemplate,
} from "./templates";
import { getEmailOtpTemplate, getAccountLockedEmailTemplate } from "./templates/auth";
import {
  getWorkLogApprovedEmailTemplate,
  getWorkLogRejectedEmailTemplate,
  getOnboardingWelcomeEmailTemplate,
  getOnboardingTaskEmailTemplate,
} from "./templates/notifications-misc";

export abstract class EmailSendersBase {
  sendEmail(options: EmailOptions): Promise<void> {
    return dispatchEmail(options);
  }

  sendVerificationEmail(email: string, token: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: "Verify your email address",
      html: getVerificationEmailTemplate(`${appUrl}/verify-email?token=${token}&email=${encodeURIComponent(email)}`),
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

  sendInvitationRevokedEmail(email: string, organizationName: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Your invitation to ${organizationName} was withdrawn`,
      html: getInvitationRevokedEmailTemplate(organizationName),
    });
  }

  sendMembershipRemovedEmail(
    email: string,
    recipientName: string,
    organizationName: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Your access to ${organizationName} was removed`,
      html: getMembershipRemovedEmailTemplate(recipientName, organizationName),
    });
  }

  sendMembershipSuspendedEmail(
    email: string,
    recipientName: string,
    organizationName: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Your access to ${organizationName} is suspended`,
      html: getMembershipSuspendedEmailTemplate(recipientName, organizationName),
    });
  }

  sendWelcomeEmail(email: string, name: string, setupUrl: string): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Your ${getBrandName()} account is ready`,
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
      subject: `Welcome to ${getBrandName()}`,
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
