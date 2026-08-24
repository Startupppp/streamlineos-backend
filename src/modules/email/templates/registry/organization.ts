import {
  getInvitationEmailTemplate,
  getHolidayAnnouncementEmailTemplate,
  getCompanyAnnouncementEmailTemplate,
} from "../index";
import { BASE_URL } from "./_shared";
import type { TemplateEntry } from "./_shared";

export const organizationTemplates: Record<string, TemplateEntry> = {
  "org.invitation": {
    category: "Organization",
    name: "Team Invitation",
    subject: "You've been invited to join Acme Corp",
    generateHtml: () => getInvitationEmailTemplate(`${BASE_URL()}/invitation/tok123`, "Acme Corp", "Rahul Verma"),
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
};
