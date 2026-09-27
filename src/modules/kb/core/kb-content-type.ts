import { kbPages } from "../../../db/schema";

export type KbPageContentType = NonNullable<
  (typeof kbPages.$inferInsert)["contentType"]
>;

export const KB_HELP_CENTER_CONTENT_TYPES = ["support_article"] as const satisfies readonly KbPageContentType[];

export const KB_PROCESS_CONTENT_TYPES = [
  "sop",
  "policy",
  "runbook",
  "playbook",
] as const satisfies readonly KbPageContentType[];

export const KB_PROJECT_CONTENT_TYPES = [
  "project_brief",
] as const satisfies readonly KbPageContentType[];

export const KB_TROUBLESHOOTING_CONTENT_TYPES = [
  "troubleshooting",
] as const satisfies readonly KbPageContentType[];

export const KB_INTERNAL_WIKI_CONTENT_TYPES = [
  "note",
  "decision_record",
  "meeting_notes",
] as const satisfies readonly KbPageContentType[];

export type KbHelpCenterContentType =
  (typeof KB_HELP_CENTER_CONTENT_TYPES)[number];
export type KbProcessContentType = (typeof KB_PROCESS_CONTENT_TYPES)[number];
export type KbProjectContentType = (typeof KB_PROJECT_CONTENT_TYPES)[number];
export type KbTroubleshootingContentType =
  (typeof KB_TROUBLESHOOTING_CONTENT_TYPES)[number];
export type KbInternalWikiContentType =
  (typeof KB_INTERNAL_WIKI_CONTENT_TYPES)[number];
