import {
  getCandidateRejectionEmail,
  getOfferDeadlineReminderEmail,
  getInterviewNoShowRescheduleEmail,
  getCandidateDocumentRolloutEmail,
} from "../index";
import { BASE_URL } from "./_shared";
import type { TemplateEntry } from "./_shared";

export const recruitmentTemplates: Record<string, TemplateEntry> = {
  "recruitment.rejection": {
    category: "Recruitment",
    name: "Candidate Rejection",
    subject: "Update on your application to Acme Corp",
    generateHtml: () =>
      getCandidateRejectionEmail({
        candidateName: "Arjun Kapoor",
        jobTitle: "Senior Frontend Engineer",
        companyName: "Acme Corp",
      }).html,
  },
  "recruitment.offer_deadline": {
    category: "Recruitment",
    name: "Offer Deadline Reminder",
    subject: "Reminder: your offer expires on Fri, 18 Jul 2026",
    generateHtml: () =>
      getOfferDeadlineReminderEmail({
        candidateName: "Arjun Kapoor",
        orgName: "Acme Corp",
        designation: "Senior Frontend Engineer",
        deadlineLabel: "Fri, 18 Jul 2026",
        offerLink: `${BASE_URL()}/offer/accept?token=test`,
      }).html,
  },
  "recruitment.no_show_reschedule": {
    category: "Recruitment",
    name: "Interview No-Show Reschedule",
    subject: "Let's reschedule your interview",
    generateHtml: () => getInterviewNoShowRescheduleEmail("Arjun Kapoor", "Acme Corp").html,
  },
  "recruitment.document_rollout": {
    category: "Recruitment",
    name: "Candidate Document Rollout",
    subject: "Your documents are ready — please review",
    generateHtml: () =>
      getCandidateDocumentRolloutEmail({
        candidateName: "Arjun Kapoor",
        documentLinks: [
          { title: "Offer Letter", url: `${BASE_URL()}/docs/offer-letter` },
          { title: "NDA Agreement", url: `${BASE_URL()}/docs/nda` },
        ],
      }).html,
  },
};
