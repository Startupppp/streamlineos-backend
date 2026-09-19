import {
  getProjectAssignmentEmailTemplate,
  getTicketAssignmentEmailTemplate,
  getTicketReviewRequestEmailTemplate,
  getTicketChangesRequestedEmailTemplate,
} from "../index";
import { BASE_URL, EMAIL_TEMPLATE_VERSION, defineTemplateFamily } from "./_shared";

export const projectsTemplates = defineTemplateFamily({
  "project.assigned": {
    category: "Projects",
    name: "Project Assignment",
    subject: "You've been added to Phoenix Platform",
    generateHtml: () =>
      getProjectAssignmentEmailTemplate(
        "Priya Sharma",
        "Phoenix Platform",
        "PHX-001",
        `${BASE_URL()}/build/1`,
        "Rahul Verma",
      ),
  },
  "project.ticket_assigned": {
    category: "Projects",
    name: "Ticket Assigned",
    subject: "Ticket assigned: Fix login redirect",
    generateHtml: () =>
      getTicketAssignmentEmailTemplate(
        "Priya Sharma",
        "Fix login redirect",
        "BUG",
        "HIGH",
        "Phoenix Platform",
        `${BASE_URL()}/build/1?ticket=42`,
        "Rahul Verma",
      ),
  },
  "project.review_request": {
    category: "Projects",
    name: "Ticket Review Request",
    subject: "Ready for review: Add export CSV",
    generateHtml: () =>
      getTicketReviewRequestEmailTemplate(
        "Rahul Verma",
        "Add export CSV",
        "FEATURE",
        "Phoenix Platform",
        `${BASE_URL()}/build/1?ticket=43`,
        "Priya Sharma",
        "All edge cases handled. Please review.",
      ),
  },
  "project.changes_requested": {
    category: "Projects",
    name: "Changes Requested",
    subject: "Changes requested: Add export CSV",
    generateHtml: () =>
      getTicketChangesRequestedEmailTemplate(
        "Priya Sharma",
        "Add export CSV",
        "Phoenix Platform",
        `${BASE_URL()}/build/1?ticket=43`,
        "Rahul Verma",
        "Please handle empty state on the export dialog.",
      ),
  },
}, EMAIL_TEMPLATE_VERSION);
