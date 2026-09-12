/**
 * What a provider sent, made readable and reliable.
 *
 * Nothing here knows what an inbound event is: these three answer "what did
 * this message actually say" and "when did it actually happen", which is the
 * part that varies by provider rather than by channel. Keeping them beside the
 * translation meant the adapter's own contract — refuse with a named skip, or
 * emit an event — was read through seventy lines of entity decoding.
 *
 * Pure, so a provider's odd output can be pinned from a fixture.
 */

/** The seam's own limit, matched so an in-process caller cannot exceed the wire's. */
const MAX_BODY_CHARS = 100_000;

/**
 * Only the fields a body is assembled from, declared structurally rather than
 * imported: `mail-to-inbound-event` imports this file, and naming its type here
 * would close a cycle over a type that is erased at compile time anyway — which
 * `check:cycles` counts as a real one.
 */
export interface MailBodySource {
  readonly bodyText?: string | null;
  readonly bodyHtml?: string | null;
  readonly snippet?: string | null;
}

/**
 * The message as text.
 *
 * Text over HTML: the pipeline caps and reads this, and stripping markup
 * downstream would mean every consumer re-implementing it. Some providers only
 * ever return HTML — Graph hands back `contentType: html` for almost
 * everything — so the markup is flattened here rather than left to become a
 * timeline entry full of `<div>`. The snippet is the last resort, because a
 * 160-character preview is a poor record of a conversation and a worse input to
 * anything that reads the body afterwards.
 */
export function bodyOf(message: MailBodySource): string | null {
  const text = message.bodyText?.trim();
  if (text) return text.slice(0, MAX_BODY_CHARS);

  const fromHtml = message.bodyHtml ? htmlToText(message.bodyHtml) : "";
  if (fromHtml) return fromHtml.slice(0, MAX_BODY_CHARS);

  return message.snippet?.trim() || null;
}

/**
 * Markup to something a person can read.
 *
 * Style and script blocks go first, contents and all: stripping only the tags
 * would leave a stylesheet in the middle of the email. Block boundaries become
 * newlines so paragraphs survive, and the handful of entities that actually
 * appear in mail are decoded — anything more ambitious belongs in a library,
 * and this is not rendering, it is making a body readable and searchable.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/**
 * A timestamp the rest of the system can rely on.
 *
 * Providers send several formats and occasionally something unparseable. An
 * invalid date would become `Invalid Date` and then `null` in the database,
 * losing when a conversation happened; falling back to now is wrong by minutes
 * rather than wrong by everything.
 *
 * The fallback is reported rather than hidden. `occurredAt` feeds the mailbox
 * watermark, and one message with a malformed `Date:` header would otherwise
 * move it to this instant — claiming everything up to now had been read, and
 * permanently skipping whatever the provider had not yet indexed.
 */
export function normaliseDate(value: string | null | undefined): { iso: string; estimated: boolean } {
  if (!value) return { iso: new Date().toISOString(), estimated: true };
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? { iso: new Date().toISOString(), estimated: true }
    : { iso: parsed.toISOString(), estimated: false };
}
