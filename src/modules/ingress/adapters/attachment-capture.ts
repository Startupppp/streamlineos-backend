import { createHash } from "node:crypto";

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
  | {
      readonly capture: false;
      readonly reason: "inline" | "too-large" | "budget-spent" | "no-name" | "size-unknown";
    };

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
  /**
   * The organisation goes through the same sanitiser as the rest.
   *
   * It is the tenant isolation boundary of this key, and `organizations.id` is
   * a bare `text` primary key with no format guaranteed by the column — so
   * interpolating it raw made the one segment that must never be escapable the
   * only one nothing was done to.
   */
  const safeOrganization = sanitiseSegment(organizationId, 64);
  const safeName = sanitiseSegment(fileName, 120);
  const safeMessage = sanitiseSegment(providerMessageId, 120);
  const safeAttachment = sanitiseSegment(attachmentId, 80);
  return `crm-mail/${safeOrganization}/${safeMessage}/${safeAttachment}-${safeName}`;
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
  const safe = value
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .slice(0, max);

  /**
   * A segment that sanitises away entirely becomes a hash of what it was.
   *
   * Everything made only of dots — `.`, `..`, `...` — comes out of the three
   * steps above as the empty string, and so does an empty input. That produced
   * a key with an empty path segment in the middle of it (`crm-mail/org-1//-`)
   * and, worse, the *same* key for every one of them: distinct messages
   * colliding onto one object, which is exactly what this function's contract
   * says must not happen. The hash is of the raw value, so distinct degenerate
   * ids stay distinct and a re-delivery of the same one still lands on the same
   * key.
   */
  return safe || shortHash(value);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
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

  /**
   * No declared size is unknown, never zero.
   *
   * Counting an absent size as zero meant it passed the per-file ceiling, spent
   * none of the message's budget, and let every following attachment through
   * as well — so a provider that simply omits `sizeBytes` (Gmail's attachment
   * list omits it for every attachment it returns) turned the 25MB hard ceiling
   * off entirely. Refused rather than guessed: a decision made on a number
   * nobody supplied is not a decision.
   *
   * And whoever wires this up: the size here is the provider's own metadata
   * about a file somebody else sent. Both caps have to be enforced against the
   * actual byte stream during the download as well — abort the transfer when it
   * passes the ceiling — because a declaration is a claim, not a measurement.
   */
  const size = attachment.sizeBytes;
  if (size === null || size === undefined) return { capture: false, reason: "size-unknown" };

  if (size > MAX_ATTACHMENT_BYTES) return { capture: false, reason: "too-large" };
  if (spentBytes + size > MAX_TOTAL_BYTES) return { capture: false, reason: "budget-spent" };

  return {
    capture: true,
    key: attachmentKey(organizationId, providerMessageId, attachment.id, attachment.fileName),
  };
}

/**
 * Total declared bytes for a set, as a starting budget.
 *
 * An undeclared size counts as nothing here because `decideAttachment` refuses
 * it outright — nothing undeclared is ever stored, so nothing undeclared can
 * contribute to what storing it would cost.
 */
export function bytesFor(attachments: readonly MailAttachment[]): number {
  return attachments.reduce((total, a) => total + (a.sizeBytes ?? 0), 0);
}
