import {
  getInterviewInviteEmail,
  getSelfScheduleBookingEmail,
  getBookingConfirmationEmail,
  getCandidateFeedbackEmail,
} from "../index";
import { BASE_URL } from "./_shared";
import type { TemplateEntry } from "./_shared";

export const interviewsTemplates: Record<string, TemplateEntry> = {
  "interview.invite_candidate": {
    category: "Interviews",
    name: "Interview Invite (Candidate)",
    subject: "Interview invitation — Senior Frontend Engineer at Acme Corp",
    generateHtml: () =>
      getInterviewInviteEmail({
        recipientName: "Arjun Kapoor",
        candidateName: "Arjun Kapoor",
        jobTitle: "Senior Frontend Engineer",
        companyName: "Acme Corp",
        scheduledAt: "Tue, 15 Jul 2026, 10:00 AM",
        durationMinutes: 60,
        format: "Video call",
        meetingLink: "https://meet.google.com/abc-def-ghi",
        recipientRole: "candidate",
      }).html,
  },
  "interview.invite_interviewer": {
    category: "Interviews",
    name: "Interview Invite (Interviewer)",
    subject: "You're interviewing Arjun Kapoor on Tue, 15 Jul 2026, 10:00 AM",
    generateHtml: () =>
      getInterviewInviteEmail({
        recipientName: "Priya Sharma",
        candidateName: "Arjun Kapoor",
        jobTitle: "Senior Frontend Engineer",
        companyName: "Acme Corp",
        scheduledAt: "Tue, 15 Jul 2026, 10:00 AM",
        durationMinutes: 60,
        format: "Video call",
        meetingLink: "https://meet.google.com/abc-def-ghi",
        recipientRole: "interviewer",
      }).html,
  },
  "interview.self_schedule": {
    category: "Interviews",
    name: "Self-Schedule Booking Link",
    subject: "Schedule your interview with Acme Corp",
    generateHtml: () =>
      getSelfScheduleBookingEmail(
        "Arjun Kapoor",
        `${BASE_URL}/schedule/abc123`,
        "Fri, 11 Jul 2026",
        "Acme Corp",
      ).html,
  },
  "interview.booking_confirmation": {
    category: "Interviews",
    name: "Booking Confirmation (Internal)",
    subject: "Arjun Kapoor scheduled their interview",
    generateHtml: () => getBookingConfirmationEmail("Arjun Kapoor", "Tue, 15 Jul 2026, 10:00 AM").html,
  },
  "interview.candidate_feedback": {
    category: "Interviews",
    name: "Candidate Feedback Request",
    subject: "How was your interview experience?",
    generateHtml: () =>
      getCandidateFeedbackEmail({
        candidateName: "Arjun Kapoor",
        orgName: "Acme Corp",
        scheduledAt: new Date("2026-07-15T10:00:00+05:30"),
      }).html,
  },
};
