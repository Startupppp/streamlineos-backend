import type { Permission } from "./types";

export const CHAT_PERMISSIONS: Permission[] = [
  {
    name: "chat:channels:read",
    resource: "chat:channels",
    action: "read",
    description: "View chat channels",
  },
  {
    name: "chat:channels:write",
    resource: "chat:channels",
    action: "write",
    description: "Create and update chat channels",
  },
  {
    name: "chat:messages:read",
    resource: "chat:messages",
    action: "read",
    description: "Read chat messages",
  },
  {
    name: "chat:messages:write",
    resource: "chat:messages",
    action: "write",
    description: "Send and edit chat messages",
  },
  {
    name: "chat:huddles:start",
    resource: "chat:huddles",
    action: "start",
    description: "Start a voice or video huddle in a channel",
  },
  {
    name: "chat:huddles:moderate",
    resource: "chat:huddles",
    action: "moderate",
    description: "Kick participants from an active huddle",
  },
  {
    name: "chat:invite-links:manage",
    resource: "chat:invite-links",
    action: "manage",
    description: "Mint or regenerate channel invite links",
  },
  {
    name: "chat:messages:pin",
    resource: "chat:messages",
    action: "pin",
    description: "Pin or unpin messages in a channel",
  },
  {
    name: "chat:org-settings:manage",
    resource: "chat:org-settings",
    action: "manage",
    description: "Manage organisation-wide chat settings",
  },
  {
    name: "ai:chat:use",
    resource: "ai:chat",
    action: "use",
    description: "Use the AI chat assistant",
  },
  {
    name: "ai:feedback:create",
    resource: "ai:feedback",
    action: "create",
    description: "Submit thumbs-up/down feedback on AI responses",
  },
];
