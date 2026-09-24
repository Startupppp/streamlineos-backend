import {
  resolveProvider,
  type ProviderBlocked,
  type ProviderCredentials,
} from "../integrations/provider-blocked";

export const CHAT_PLATFORMS = ["SLACK", "TEAMS"] as const;
export type ChatPlatform = (typeof CHAT_PLATFORMS)[number];

export interface InterviewNotice {
  /** Who it is about, by first name only. */
  candidateFirstName: string;
  jobTitle: string;
  /** Already formatted for the organisation's timezone by the caller. */
  whenText: string;
  durationMinutes: number;
  /** A path, not an absolute URL; the sender prefixes the app origin. */
  scorecardPath: string;
  kind: "assigned" | "rescheduled" | "cancelled";
}

/**
 * The message an interviewer receives, in a channel this product does not own.
 *
 * Deliberately thin on the candidate. A Slack channel is readable by everyone
 * in it, searchable forever, and frequently mirrored into third-party tools; a
 * notice that carried a surname, an email, a résumé link or a salary would put
 * all of that somewhere no permission of ours reaches. First name, role, time
 * and a link back into StreamlineOS is everything an interviewer needs to show
 * up, and everything behind that link is still gated.
 */
export function buildInterviewNotice(notice: InterviewNotice): string {
  const verb =
    notice.kind === "assigned"
      ? "You are interviewing"
      : notice.kind === "rescheduled"
        ? "Interview moved"
        : "Interview cancelled";

  const lines = [
    `*${verb}* — ${notice.candidateFirstName} for ${notice.jobTitle}`,
    `${notice.whenText} · ${notice.durationMinutes} min`,
  ];
  if (notice.kind !== "cancelled") {
    lines.push(`Scorecard: ${notice.scorecardPath}`);
  }
  return lines.join("\n");
}

/**
 * Fields a notice must never carry, asserted rather than trusted.
 *
 * `buildInterviewNotice` takes a first name and cannot see the rest, so this
 * guard is about the next change rather than this one: widening the input to
 * "the candidate" is a one-line edit that nothing else would catch.
 */
const FORBIDDEN_IN_NOTICE = ["@", "salary", "ctc", "resume", "résumé", "aadhaar", "pan "];

export function noticeLeaksSomething(message: string): string | null {
  const lower = message.toLowerCase();
  return FORBIDDEN_IN_NOTICE.find((bad) => lower.includes(bad)) ?? null;
}

export interface ChatAdapter {
  post(credentials: ProviderCredentials, message: string): Promise<void>;
}

/**
 * Empty, and the consequence here is mild by the standards of this lane: an
 * interviewer is not told in Slack. It stays empty anyway, because a stub that
 * swallowed the post would make "notified" true in our logs and false in the
 * world, and the interviewer who did not turn up is the one who finds out.
 */
export const CHAT_ADAPTERS: ReadonlyMap<ChatPlatform, ChatAdapter> = new Map();

export function resolveChat(
  platform: ChatPlatform,
  credentials: ProviderCredentials | null,
): { adapter: ChatAdapter; credentials: ProviderCredentials } | ProviderBlocked {
  return resolveProvider(
    platform,
    credentials,
    CHAT_ADAPTERS,
    platform === "SLACK" ? "Slack notifications" : "Microsoft Teams notifications",
    "Interviewers still get the email and the calendar invite.",
  );
}
