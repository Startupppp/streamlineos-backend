import { EXCLUDED_FOLDERS, PRIVATE_LABELS } from "./mail-ingress-privacy";
import { type MailMessageForIngress, type PrivateLabelRule } from "./mail-to-inbound-event";
import type { MailMessageSummary } from "../../mail/dto/mail-schemas";

export const MAX_PER_PAGE = 100;

export const MAX_PAGES_PER_SWEEP = 25;

export const MAX_DETAIL_FETCHES_PER_SWEEP = 50;

export const MAX_DETAIL_FAILURES = 3;

export const GMAIL_EXCLUSIONS = [...PRIVATE_LABELS, ...EXCLUDED_FOLDERS]
  .map((label) => `-label:${label.replace(/\s+/g, "-")}`)
  .join(" ");

export interface SweepRead {
  readonly messages: readonly MailMessageForIngress[];
  readonly privateLabelRule: PrivateLabelRule;
  readonly truncated: boolean;
}

export function forIngress(
  message: MailMessageSummary,
  labels: readonly string[] | null,
): MailMessageForIngress {
  return {
    id: message.id,
    threadId: message.threadId,
    from: message.from,
    to: message.to,
    subject: message.subject,
    snippet: message.snippet,
    date: message.date,
    labels,
  };
}

export function sweepNote(
  truncated: boolean,
  firstRun: boolean,
  read: number,
  unjudged: number,
): string | null {
  if (truncated)
    return firstRun
      ? `The first sweep read the ${read} most recent messages in the lookback window and there were more; older mail was left in the mailbox.`
      : `Read ${read} messages and there are still more in the window. Nothing has been skipped — the watermark is held — but a backlog this size will not drain on its own.`;

  if (unjudged > 0)
    return `${unjudged} of ${read} messages were left alone because the provider did not say which labels they carry. Nothing is filed from this mailbox until it does — a message somebody marked private must not be guessed at.`;

  return null;
}
