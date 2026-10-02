import { definePermissions } from "./types";

export const SUPPORT_PERMISSIONS = definePermissions([
  {
    name: "support:kb:view",
    resource: "support:kb",
    action: "view",
    description: "View and browse knowledge base articles",
  },
  {
    name: "support:kb:manage",
    resource: "support:kb",
    action: "manage",
    description:
      "Create, edit, and publish knowledge base articles and categories",
  },
  {
    name: "support:macros:view",
    resource: "support:macros",
    action: "view",
    description: "View canned responses and ticket routing rules",
  },
  {
    name: "support:macros:manage",
    resource: "support:macros",
    action: "manage",
    description: "Create and edit canned responses and ticket routing rules",
  },
  {
    name: "support:tickets:manage",
    resource: "support:tickets",
    action: "manage",
    description: "Manage support tickets",
    scopable: true,
  },
  {
    name: "support:tickets:view",
    resource: "support:tickets",
    action: "view",
    description: "View support tickets, messages, and activity",
    scopable: true,
  },
  {
    name: "support:tickets:create",
    resource: "support:tickets",
    action: "create",
    description: "Create support tickets",
  },
  {
    name: "support:tickets:reply",
    resource: "support:tickets",
    action: "reply",
    description: "Post public replies on support tickets",
    scopable: true,
  },
  {
    name: "support:tickets:internal_note",
    resource: "support:tickets",
    action: "internal_note",
    description: "Post internal notes on support tickets",
    scopable: true,
  },
  {
    name: "support:settings:manage",
    resource: "support:settings",
    action: "manage",
    description:
      "Manage support SLA policies, business hours, and routing settings",
  },
  {
    name: "support:reports:view",
    resource: "support:reports",
    action: "view",
    description: "View support reports and analytics",
  },
  {
    name: "support:csat:view",
    resource: "support:csat",
    action: "view",
    description: "View CSAT surveys and responses",
  },
  {
    name: "support:csat:manage",
    resource: "support:csat",
    action: "manage",
    description: "Create, update and delete CSAT surveys",
  },
  {
    name: "support:ai:view",
    resource: "support:ai",
    action: "view",
    description: "View support AI reporting and insights",
  },
  {
    name: "support:ai:invoke",
    resource: "support:ai",
    action: "invoke",
    description:
      "Use support AI features (reply/macro improvement, translation)",
  },
  {
    name: "support:queues:manage",
    resource: "support:queues",
    action: "manage",
    description: "Create and manage support ticket queues",
  },
  {
    name: "support:tags:manage",
    resource: "support:tags",
    action: "manage",
    description: "Create and manage support ticket tags",
  },
  {
    name: "support:portal:tickets:view",
    resource: "support:portal:tickets",
    action: "view",
    description: "View own support tickets via the customer portal",
  },
  {
    name: "support:portal:tickets:create",
    resource: "support:portal:tickets",
    action: "create",
    description: "Create support tickets via the customer portal",
  },
  {
    name: "support:portal:tickets:reply",
    resource: "support:portal:tickets",
    action: "reply",
    description: "Reply to own support tickets via the customer portal",
  },
  {
    name: "support:channels:manage",
    resource: "support:channels",
    action: "manage",
    description:
      "Configure support channels (email inbox, chat, WhatsApp, SMS)",
  },
  {
    name: "support:knowledge-gaps:view",
    resource: "support:knowledge-gaps",
    action: "view",
    description: "View knowledge gap analysis and clustered support questions",
  },
  {
    name: "support:knowledge-gaps:manage",
    resource: "support:knowledge-gaps",
    action: "manage",
    description:
      "Trigger gap detection, draft KB articles from gaps, and dismiss gaps",
  },
]);
