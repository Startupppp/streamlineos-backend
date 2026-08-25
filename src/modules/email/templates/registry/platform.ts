import {
  getContactAdminNotificationEmail,
  getContactAutoreplyEmail,
  getContactReplyEmail,
  getTrialReminderEmail,
  getWaitlistAdminNotificationEmail,
  getWaitlistConfirmationEmail,
} from "../index";
import { BASE_URL, BRAND } from "./_shared";
import type { TemplateEntry } from "./_shared";

export const platformTemplates: Record<string, TemplateEntry> = {
  "platform.contact_admin": {
    category: "Platform",
    name: "Contact Form — Admin Notification",
    subject: "New billing message from Rohan Mehta",
    generateHtml: () =>
      getContactAdminNotificationEmail({
        name: "Rohan Mehta",
        email: "rohan@example.com",
        topic: "billing",
        message: "I was charged twice for my subscription this month.",
        reference: "REF-2026-001",
        receivedAt: "Wed, 2 Jul 2026, 10:15 AM",
        company: "Mehta Solutions",
        inboxUrl: `${BASE_URL()}/platform/inbox`,
      }).html,
  },
  "platform.contact_autoreply": {
    category: "Platform",
    name: "Contact Form — Customer Autoreply",
    subject: "We received your message",
    generateHtml: () =>
      getContactAutoreplyEmail({
        name: "Rohan Mehta",
        message: "I was charged twice for my subscription this month.",
      }).html,
  },
  "platform.contact_reply": {
    category: "Platform",
    name: "Contact Form — Staff Reply",
    subject: `Re: your billing message to ${BRAND}`,
    generateHtml: () =>
      getContactReplyEmail({
        name: "Rohan Mehta",
        replyBody:
          "Hi Rohan, we identified the duplicate charge and have initiated a refund. It should appear in 3-5 business days.",
        originalMessage: "I was charged twice for my subscription this month.",
        originalTopic: "billing",
      }).html,
  },
  "platform.waitlist_admin": {
    category: "Platform",
    name: "Waitlist — Admin Notification",
    subject: "New waitlist signup — Rohan Mehta",
    generateHtml: () =>
      getWaitlistAdminNotificationEmail({
        name: "Rohan Mehta",
        email: "rohan@example.com",
        reference: "WL-2026-001",
        receivedAt: "Wed, 2 Jul 2026, 10:15 AM",
        organization: "Mehta Solutions",
        role: "Head of Operations",
        teamSize: "11-50",
        notes: "We run HR on spreadsheets and projects in three different tools.",
      }).html,
  },
  "platform.waitlist_confirmation": {
    category: "Platform",
    name: "Waitlist — Confirmation",
    subject: `You're on the ${BRAND} waitlist`,
    generateHtml: () =>
      getWaitlistConfirmationEmail({
        name: "Rohan Mehta",
        reference: "WL-2026-001",
      }).html,
  },
  "platform.trial_reminder": {
    category: "Platform",
    name: "Trial Reminder",
    subject: "Your trial ends in 5 days",
    generateHtml: () =>
      getTrialReminderEmail({
        orgName: "Mehta Solutions",
        daysLeft: 5,
        upgradeUrl: `${BASE_URL()}/billing/upgrade`,
        plan: "Business",
      }).html,
  },
};
