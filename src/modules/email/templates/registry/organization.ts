import {
  getInvitationEmailTemplate,
  getMembershipAddedEmailTemplate,
  getHolidayAnnouncementEmailTemplate,
  getCompanyAnnouncementEmailTemplate,
} from "..";
import { BASE_URL, EMAIL_TEMPLATE_VERSION, defineTemplateFamily } from "./_shared";

export const organizationTemplates = defineTemplateFamily({
  "org.invitation": {
    category: "Organization",
    name: "Team Invitation",
    subject: "You've been invited to join Acme Corp",
    generateHtml: () => getInvitationEmailTemplate(`${BASE_URL()}/invitation/tok123`, "Acme Corp", "Rahul Verma"),
  },
  "org.membership-added": {
    category: "Organization",
    name: "Added to Organization",
    subject: "You've been added to Acme Corp",
    generateHtml: () =>
      getMembershipAddedEmailTemplate("Priya Sharma", "Acme Corp", `${BASE_URL()}/magic-link?token=test-token`),
  },
  "org.holiday": {
    category: "Organization",
    name: "Holiday Announcement",
    subject: "Upcoming holiday: Diwali",
    generateHtml: () =>
      getHolidayAnnouncementEmailTemplate("Diwali", "Mon, 20 Oct 2025", "Office closed for Diwali."),
  },
  "org.announcement": {
    category: "Organization",
    name: "Company Announcement",
    subject: "Announcement: New HR Policy",
    generateHtml: () =>
      getCompanyAnnouncementEmailTemplate(
        "New HR Policy",
        "Effective 1 Aug 2025, leave requests must be submitted 5 working days in advance.",
        "Rahul Verma",
      ),
  },
}, EMAIL_TEMPLATE_VERSION);
