/**
 * Which mail a person has kept out of the CRM.
 *
 * This is the ingress privacy policy, and it is deliberately separate from the
 * event mapping in `mail-to-inbound-event.ts`: the label and folder vocabulary
 * changes when a provider or a tenant convention changes, while the mapping
 * changes when the inbound-event contract does. Two sweep paths already read
 * this vocabulary — one filters in process, one hands it to the provider as a
 * query — so it has to be one list with one meaning.
 */

/**
 * Labels a person uses to keep a message out of the CRM.
 *
 * Compared case-insensitively against the provider's own labels and folders,
 * because a person marking mail private is doing it in their mail client and
 * has no idea this system exists. `Private` and `CRM-Exclude` are the two
 * conventions worth honouring by default; a tenant can be given more later, but
 * honouring none by default would make personal mail a support ticket rather
 * than a setting.
 *
 * Exported because a sweep that cannot see labels has to ask the provider to
 * exclude these instead, and two copies of this list would drift apart on the
 * day somebody adds to one of them.
 */
export const PRIVATE_LABELS = [
  "private",
  "personal",
  "confidential",
  "crm-exclude",
  "no-crm",
] as const;

/** Folders whose contents are not correspondence with anybody. */
export const EXCLUDED_FOLDERS = [
  "spam",
  "junk",
  "junk email",
  "trash",
  "deleted items",
  "drafts",
] as const;

const EXCLUDED = new Set<string>([...PRIVATE_LABELS, ...EXCLUDED_FOLDERS]);
export function isPrivate(labels: readonly string[]): boolean {
  return labels.some((label) => EXCLUDED.has(label.trim().toLowerCase()));
}

/**
 * Whether this message is one the person kept out of the CRM.
 *
 * Exported for one reason: a sweep that fetches a message's full text costs a
 * provider call and pulls the body of the message across, and doing that for
 * something already marked private is both waste and exactly the content nobody
 * asked us to handle. Unknown labels are not private here — they are refused by
 * `mailToInboundEvent` instead, which is where a refusal belongs.
 */
export function isPrivateMessage(message: { readonly labels: readonly string[] | null }): boolean {
  return message.labels !== null && isPrivate(message.labels);
}
