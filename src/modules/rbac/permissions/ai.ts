import { definePermissions } from "./types";

export const AI_SUMMARIES_PERMISSIONS = definePermissions([
  {
    name: "ai:summaries:view",
    resource: "ai:summaries",
    action: "view",
    description: "View AI-generated summary snapshots and diffs",
  },
  {
    name: "ai:summaries:create",
    resource: "ai:summaries",
    action: "create",
    description: "Persist AI-generated summary snapshots",
  },
]);

export const EXECUTIVE_BRIEF_PERMISSIONS = definePermissions([
  {
    name: "ai:executive-brief:view",
    resource: "ai:executive-brief",
    action: "view",
    description: "View the AI-generated cross-module executive brief",
  },
  {
    name: "ai:executive-brief:generate",
    resource: "ai:executive-brief",
    action: "generate",
    description: "Trigger generation of a new executive brief",
  },
]);

export const AI_USAGE_PERMISSIONS = definePermissions([
  {
    name: "ai:usage:view",
    resource: "ai:usage",
    action: "view",
    description:
      "View organization-wide AI usage, spend, latency and acceptance",
  },
]);
