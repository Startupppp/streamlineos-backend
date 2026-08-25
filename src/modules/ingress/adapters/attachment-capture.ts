/**
 * Which attachments are worth keeping, and where they belong.
 *
 * Pure, because the interesting decisions are the refusals: what not to fetch,
 * what not to store, and how to name a file so one mailbox cannot overwrite
 * another's.
 */

export interface MailAttachment {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType?: string | null;
  readonly sizeBytes?: number | null;
  readonly inline?: boolean;
}

/**
 * A hard ceiling per file.
 *
 * A mailbox is an arbitrary-size input somebody else controls, and the cost of
 * a 200MB attachment is paid in the organisation's storage and in the time a
 * sweep takes. Skipped with a reason rather than truncated: half a file is a
 * corrupt file that looks like a real one.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** A whole message's worth, so one email cannot fill a bucket. */
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export type AttachmentDecision =
  | { readonly capture: true; readonly key: string }
  | { readonly capture: false; readonly reason: "inline" | "too-large" | "budget-spent" | "no-name" };

/**
 * The storage key for one attachment.
 *
 * Namespaced by organisation first so a listing is scoped by prefix, then by
 * the provider's own message id — two people receiving the same file must not
 * collide, and the same message re-delivered must land on the same key so a
 * replay overwrites rather than duplicates.
 */
export function attachmentKey(
  organizationId: string,
  providerMessageId: string,
  attachmentId: string,
  fileName: string,
): string {
  const safeName = sanitiseSegment(fileName, 120);
  const safeMessage = sanitiseSegment(providerMessageId, 120);
  const safeAttachment = sanitiseSegment(attachmentId, 80);
  return `crm-mail/${organizationId}/${safeMessage}/${safeAttachment}-${safeName}`;
}

/**
 * One path segment, from input somebody else wrote.
 *
 * A filename arrives in an email, so it is attacker-controlled. Stripping the
 * separators is not enough on its own: `../../etc` loses its slashes and
 * becomes `....etc`, which still carries a traversal sequence into whatever
 * reads the key later. Collapsing runs of dots to one removes it, and trimming
 * leading dots stops a segment that is nothing but them.
 */
function sanitiseSegment(value: string, max: number): string {
  return value
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .slice(0, max);
}

/**
 * Whether to fetch and store this one.
 *
 * `spentBytes` is the running total for the message, so the budget is enforced
 * across a set of attachments rather than per file — ten 6MB files are the
 * problem the per-file limit does not catch.
 */
export function decideAttachment(
  attachment: MailAttachment,
  organizationId: string,
  providerMessageId: string,
  spentBytes: number,
): AttachmentDecision {
  /**
   * Inline images are the signature block and the tracking pixel. Storing them
   * fills a bucket with logos and tells a reader nothing.
   */
  if (attachment.inline) return { capture: false, reason: "inline" };

  if (!attachment.fileName?.trim()) return { capture: false, reason: "no-name" };

  const size = attachment.sizeBytes ?? 0;
  if (size > MAX_ATTACHMENT_BYTES) return { capture: false, reason: "too-large" };
  if (spentBytes + size > MAX_TOTAL_BYTES) return { capture: false, reason: "budget-spent" };

  return {
    capture: true,
    key: attachmentKey(organizationId, providerMessageId, attachment.id, attachment.fileName),
  };
}

/** Total bytes a set of decisions would store, for the caller's budget. */
export function bytesFor(attachments: readonly MailAttachment[]): number {
  return attachments.reduce((total, a) => total + (a.sizeBytes ?? 0), 0);
}
