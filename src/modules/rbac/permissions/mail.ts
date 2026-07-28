import type { Permission } from "./types";

export const MAIL_PERMISSIONS: Permission[] = [
  {
    name: "mail:inbox:view",
    resource: "mail:inbox",
    action: "view",
    description: "View unified mail inbox and messages",
  },
  {
    name: "mail:messages:send",
    resource: "mail:messages",
    action: "send",
    description: "Send and reply to emails",
  },
  {
    name: "mail:messages:manage",
    resource: "mail:messages",
    action: "manage",
    description: "Archive, trash, star, and mark email messages",
  },
  {
    name: "mail:ai:use",
    resource: "mail:ai",
    action: "use",
    description: "Use AI inbox summary, thread summary, and draft generation",
  },
];
