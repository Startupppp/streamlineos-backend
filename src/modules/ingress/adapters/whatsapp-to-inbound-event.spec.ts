import {
  normalisePhoneNumber,
  whatsAppThreadIdentity,
  whatsAppToInboundEvent,
  type WhatsAppIngressContext,
  type WhatsAppMessageForIngress,
} from "./whatsapp-to-inbound-event";
import {
  externalParticipants,
  partyNameFor,
  senderOf,
  threadIdentity,
  validateInboundEvent,
} from "../inbound-event";
import { MAX_ATTACHMENT_BYTES } from "./attachment-capture";
import { inboundEventSchema } from "../dto/inbound-event.schemas";
import {
  FIXTURE_BUSINESS_NUMBER,
  FIXTURE_CUSTOMER_NAME,
  FIXTURE_CUSTOMER_WA_ID,
  FIXTURE_TIMESTAMP,
} from "./whatsapp-webhook.fixture";

/**
 * Asserts the shape and nothing else, deliberately — the same rule the mail
 * adapter's tests keep. If this file started asserting that a party was created
 * or an activity logged, the adapter would be coupled to the pipeline and every
 * provider field rename would mean re-testing the whole thing.
 *
 * No provider SDK is mocked here or anywhere else in the channel. Inbound
 * WhatsApp is a signed HTTP body, so the fixture is the provider.
 */

const context: WhatsAppIngressContext = {
  organizationId: "org-1",
  provider: "whatsapp",
  businessNumber: FIXTURE_BUSINESS_NUMBER,
};

const message = (over: Partial<WhatsAppMessageForIngress> = {}): WhatsAppMessageForIngress => ({
  id: "wamid.HBgMOTE5ODc2NTQzMjEw",
  from: FIXTURE_CUSTOMER_WA_ID,
  timestamp: FIXTURE_TIMESTAMP,
  type: "text",
  text: "Can you resend the quote?",
  profileName: FIXTURE_CUSTOMER_NAME,
  ...over,
});

const ok = (result: ReturnType<typeof whatsAppToInboundEvent>) => {
  if (!result.ok) throw new Error(`expected an event, got skip: ${result.reason}`);
  return result;
};

describe("whatsAppToInboundEvent", () => {
  it("produces an event the seam accepts", () => {
    // The seam is the contract, so validating against it is stronger than
    // checking fields by hand.
    expect(validateInboundEvent(ok(whatsAppToInboundEvent(message(), context)).event)).toEqual([]);
  });

  it("carries the provider's identifiers through for deduplication", () => {
    expect(ok(whatsAppToInboundEvent(message(), context)).event).toMatchObject({
      channel: "message",
      provider: "whatsapp",
      providerMessageId: "wamid.HBgMOTE5ODc2NTQzMjEw",
    });
  });

  it("reads the provider's unix-seconds timestamp as the moment it happened", () => {
    const result = ok(whatsAppToInboundEvent(message(), context));
    expect(result.event.occurredAt).toBe("2025-08-25T08:00:00.000Z");
    expect(result.occurredAtEstimated).toBe(false);
  });

  /**
   * A message placed at ingest time sits in the wrong place on a timeline, so
   * the fallback is reported rather than hidden — the same discipline the mail
   * adapter keeps for the watermark it feeds.
   */
  it("reports when it had to invent the timestamp", () => {
    for (const timestamp of [null, "", "not-a-timestamp", "0", "-5"]) {
      const result = ok(whatsAppToInboundEvent(message({ timestamp }), context));
      expect(result.occurredAtEstimated).toBe(true);
      expect(Number.isNaN(new Date(result.event.occurredAt).getTime())).toBe(false);
    }
  });

  it("has no subject, and does not invent one", () => {
    expect(ok(whatsAppToInboundEvent(message(), context)).event.subject).toBeNull();
  });
});

describe("threading", () => {
  /**
   * The heart of the ticket. WhatsApp gives an inbound message no conversation
   * id, so the pair is not a courtesy fallback — it is the normal path.
   */
  it("threads on the participant pair when the provider gives no conversation id", () => {
    const event = ok(whatsAppToInboundEvent(message(), context)).event;
    expect(event.providerThreadId).toBe("org-1:message:+15550001111|+919876543210");
  });

  it("puts every message between the same two numbers on one thread", () => {
    const first = ok(whatsAppToInboundEvent(message({ id: "wamid.A" }), context)).event;
    const second = ok(whatsAppToInboundEvent(message({ id: "wamid.B" }), context)).event;
    expect(first.providerThreadId).toBe(second.providerThreadId);
  });

  /**
   * Order-independent, so a reply the business sends lands on the same thread
   * as the message that prompted it rather than starting a second one.
   */
  it("gives the same thread whichever end is the sender", () => {
    const inbound = whatsAppThreadIdentity(message(), context);
    const outbound = whatsAppThreadIdentity(
      message({ from: FIXTURE_BUSINESS_NUMBER }),
      { ...context, businessNumber: FIXTURE_CUSTOMER_WA_ID },
    );
    expect(inbound).toBe(outbound);
  });

  it("separates two customers, and two business lines", () => {
    const pair = whatsAppThreadIdentity(message(), context);
    expect(whatsAppThreadIdentity(message({ from: "919000000000" }), context)).not.toBe(pair);
    expect(whatsAppThreadIdentity(message(), { ...context, businessNumber: "15552223333" })).not.toBe(
      pair,
    );
    expect(whatsAppThreadIdentity(message(), { ...context, organizationId: "org-2" })).not.toBe(pair);
  });

  it("prefers the provider's conversation id over the pair, where there is one", () => {
    const event = ok(
      whatsAppToInboundEvent(message({ conversationId: " conv-77 " }), context),
    ).event;
    expect(event.providerThreadId).toBe("conv-77");
  });

  /**
   * The reply pointer names one message, not a conversation. Threading on it
   * would split an exchange into a chain per quote and leave every unquoted
   * message alone.
   */
  it("ignores the reply pointer", () => {
    const quoted = ok(whatsAppToInboundEvent(message({ contextMessageId: "wamid.EARLIER" }), context));
    expect(quoted.event.providerThreadId).toBe("org-1:message:+15550001111|+919876543210");
  });

  /**
   * The reason the adapter sets `providerThreadId` at all. The seam's own
   * fallback synthesises from the subject, and WhatsApp has none — so an event
   * handed over without a thread id would get one thread per message, which is
   * a pile rather than a conversation.
   */
  it("is what stops the seam from giving every message its own thread", () => {
    const event = ok(whatsAppToInboundEvent(message(), context)).event;
    expect(threadIdentity(event)).toBe(event.providerThreadId);

    const unthreaded = { ...event, providerThreadId: null };
    expect(threadIdentity(unthreaded)).toBe(`org-1:message:${event.providerMessageId}`);
    expect(threadIdentity({ ...unthreaded, providerMessageId: "wamid.OTHER" })).not.toBe(
      threadIdentity(unthreaded),
    );
  });
});

describe("participants", () => {
  it("puts both ends of the conversation on the event", () => {
    const event = ok(whatsAppToInboundEvent(message(), context)).event;
    expect(event.participants).toEqual([
      {
        address: "+919876543210",
        displayName: FIXTURE_CUSTOMER_NAME,
        role: "from",
        // Stated by the adapter, because the channel cannot say it: web forms
        // arrive as `message` too, carrying an email address.
        identifierKind: "whatsapp",
      },
      { address: "+15550001111", role: "to", identifierKind: "whatsapp" },
    ]);
  });

  /**
   * A business number is typed into a settings field by a person, and a `wa_id`
   * is bare digits. One person must not become two parties because of a space.
   */
  it("normalises every way a number can be written to one address", () => {
    expect(normalisePhoneNumber("+91 98765 43210")).toBe("+919876543210");
    expect(normalisePhoneNumber("919876543210")).toBe("+919876543210");
    expect(normalisePhoneNumber("(0091) 98765-43210")).toBe("+919876543210");
    expect(normalisePhoneNumber("")).toBe("");
    expect(normalisePhoneNumber("not a number")).toBe("");
  });

  /**
   * Without the profile name a new party is named after its own phone number,
   * because the seam's `partyNameFor` has no local part to make a name from.
   */
  it("carries the sender's profile name where the provider gave one", () => {
    const anonymous = ok(whatsAppToInboundEvent(message({ profileName: null }), context)).event;
    expect(anonymous.participants[0]?.displayName).toBeNull();
  });
});

describe("refusals", () => {
  it("refuses a message with nothing to deduplicate on", () => {
    expect(whatsAppToInboundEvent(message({ id: "  " }), context)).toEqual({
      ok: false,
      reason: "no-identifier",
    });
  });

  it("refuses a message with nobody to attribute it to", () => {
    expect(whatsAppToInboundEvent(message({ from: "" }), context)).toEqual({
      ok: false,
      reason: "no-sender",
    });
  });

  /**
   * The lesson the mailbox paid for: a property that cannot be established is a
   * refusal, not an assumption. Threading on the sender alone would merge every
   * conversation a customer has with an organisation that runs a sales number
   * and a support number, and a merged timeline cannot be unmerged.
   */
  it("refuses rather than threading on one end when the business number is missing", () => {
    for (const businessNumber of ["", "   ", "n/a"]) {
      expect(whatsAppToInboundEvent(message(), { ...context, businessNumber })).toEqual({
        ok: false,
        reason: "no-business-number",
      });
    }
  });

  it("refuses an echo of the organisation's own number", () => {
    expect(
      whatsAppToInboundEvent(message({ from: FIXTURE_BUSINESS_NUMBER }), context),
    ).toEqual({ ok: false, reason: "own-number-noise" });
  });

  /**
   * Named refusals rather than silent drops: a caller that finds itself
   * refusing every message can say so, which is the difference between a
   * channel that is quiet and one that is broken.
   */
  it("refuses the message types that are not correspondence, by name", () => {
    for (const type of ["reaction", "system", "location", "contacts", "interactive", "order"]) {
      expect(whatsAppToInboundEvent(message({ type }), context)).toEqual({
        ok: false,
        reason: "unsupported-type",
      });
    }
  });

  it("refuses a message with neither text nor a file", () => {
    expect(whatsAppToInboundEvent(message({ text: "   " }), context)).toEqual({
      ok: false,
      reason: "empty",
    });
  });
});

/**
 * The body cap, which nothing asserted.
 *
 * `bodyOf` truncates to the same 100,000 characters the seam's own wire schema
 * enforces, so an in-process caller cannot hand the pipeline a body the wire
 * contract would reject — the adapter is reachable directly, not only through a
 * webhook, and a relay is not bound by Meta's own message-length limit.
 *
 * Deleting the `.slice(0, MAX_BODY_CHARS)` left all twenty-one ingress suites
 * green, so the bound was inert as far as the tests were concerned.
 *
 * Note where the real limit lives: `validateInboundEvent` does NOT check body
 * length — it checks structure — so an oversized body passes it. The cap is on
 * `inboundEventSchema`, the wire contract, which is why the second case asserts
 * against that rather than against a number copied into this file. Both halves
 * are needed: the first would still pass if somebody changed the constant, and
 * the second would still pass if somebody removed the truncation but the wire
 * limit were also raised.
 */
describe("the body cap", () => {
  const LIMIT = 100_000;
  const oversized = "x".repeat(LIMIT + 500);

  it("truncates a body longer than the seam accepts", () => {
    const result = whatsAppToInboundEvent(message({ text: oversized }), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.body).toHaveLength(LIMIT);
  });

  it("produces an event the seam's wire contract still accepts, which is the point", () => {
    const result = whatsAppToInboundEvent(message({ text: oversized }), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(inboundEventSchema.safeParse(result.event).success).toBe(true);
    // Control: without the truncation this is what the seam would have said.
    expect(inboundEventSchema.safeParse({ ...result.event, body: oversized }).success).toBe(false);
  });

  it("caps a caption the same way, since a caption is the body", () => {
    const result = whatsAppToInboundEvent(
      message({
        type: "image",
        text: null,
        media: { id: "media-cap", mimeType: "image/jpeg", caption: oversized },
      }),
      context,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.body).toHaveLength(LIMIT);
  });

  it("leaves an ordinary body exactly as the sender wrote it", () => {
    const result = whatsAppToInboundEvent(message({ text: "Can you resend the quote?" }), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.body).toBe("Can you resend the quote?");
  });
});

describe("media", () => {
  const withDocument = (over: Record<string, unknown> = {}) =>
    message({
      type: "document",
      text: null,
      media: {
        id: "media-9f2c",
        mimeType: "application/pdf",
        fileName: "quote.pdf",
        caption: "Signed copy.",
        sizeBytes: 2048,
        ...over,
      },
    });

  it("takes the caption as the body, because a caption is what the sender said", () => {
    expect(ok(whatsAppToInboundEvent(withDocument(), context)).event.body).toBe("Signed copy.");
  });

  it("keeps a file with no caption, since the file is the message", () => {
    const result = ok(whatsAppToInboundEvent(withDocument({ caption: null }), context));
    expect(result.event.body).toBeNull();
    expect(result.media).toHaveLength(1);
  });

  it("captures through the email path, with the email path's key", () => {
    const [decision] = ok(whatsAppToInboundEvent(withDocument(), context)).media;
    expect(decision?.decision).toEqual({
      capture: true,
      key: expect.stringContaining("org-1/wamid.HBgMOTE5ODc2NTQzMjEw/media-9f2c-quote.pdf"),
    });
  });

  /**
   * A filename from WhatsApp is exactly as attacker-controlled as one from
   * email, and it goes through the one sanitiser rather than a second one
   * written for this channel.
   */
  it("sanitises a hostile filename with the sanitiser email already uses", () => {
    const [decision] = ok(
      whatsAppToInboundEvent(withDocument({ fileName: "../../etc/passwd" }), context),
    ).media;
    if (!decision?.decision.capture) throw new Error("expected a capture");
    expect(decision.decision.key).not.toContain("..");
    expect(decision.decision.key).not.toContain("//");
    expect(decision.decision.key.startsWith("crm-mail/org-1/")).toBe(true);
  });

  /**
   * Images, video, audio and stickers carry no filename at all — only an id and
   * a mime type — so one is made from the id, which keeps two photos in the
   * same conversation on separate keys.
   */
  it("names a file the sender never named, from the media id", () => {
    const image = message({
      type: "image",
      text: null,
      media: { id: "media-4b7e", mimeType: "image/jpeg", caption: "cracked", sizeBytes: 900 },
    });
    const [decision] = ok(whatsAppToInboundEvent(image, context)).media;
    expect(decision?.fileName).toBe("media-4b7e.jpeg");

    const second = message({
      id: "wamid.SECOND",
      type: "image",
      text: null,
      media: { id: "media-0000", mimeType: "image/jpeg", caption: "and this", sizeBytes: 900 },
    });
    const [other] = ok(whatsAppToInboundEvent(second, context)).media;
    expect(other?.fileName).not.toBe(decision?.fileName);
  });

  it("keeps the email path's ceiling rather than a second one", () => {
    const [decision] = ok(
      whatsAppToInboundEvent(withDocument({ sizeBytes: MAX_ATTACHMENT_BYTES + 1 }), context),
    ).media;
    expect(decision?.decision).toEqual({ capture: false, reason: "too-large" });
  });

  /**
   * The Cloud API's media object carries an id, a mime type and a checksum but
   * no size — the size only exists on the separate media-metadata read. So
   * every webhook-delivered file is refused until that read is wired, which is
   * the correct refusal: `decideAttachment` will not treat an undeclared size
   * as zero, because that turned the 25MB ceiling off entirely for Gmail.
   */
  it("refuses a file whose size the webhook did not declare", () => {
    const [decision] = ok(whatsAppToInboundEvent(withDocument({ sizeBytes: null }), context)).media;
    expect(decision?.decision).toEqual({ capture: false, reason: "size-unknown" });
  });

  it("decides nothing for a message carrying no file", () => {
    expect(ok(whatsAppToInboundEvent(message(), context)).media).toEqual([]);
  });
});

/**
 * What a phone number meets on the other side of the seam.
 *
 * These are pinned rather than fixed. Ticket 10 says nothing below the seam may
 * change, and the point of adding three channels is to find out whether that
 * holds — so where it does not, the evidence belongs somewhere it will be read
 * rather than in a paragraph nobody opens. Every assertion here is a finding
 * reported alongside this ticket, and any of them failing means somebody has
 * acted on one, which is the outcome these exist to prompt.
 */
describe("below the seam", () => {
  /**
   * The finding this pin was written to prompt, now acted on.
   *
   * `externalParticipants` used to keep a participant only if `addressDomain`
   * found one, and a telephone number has no domain — so `record-participants`
   * wrote nothing at all for this channel, and `AutonomyService.loadActivity`
   * left-joined a table that could never hold this sender. Ticket 22 made the
   * filter keep every kind: an address with no domain cannot be shown to be
   * internal, and on an inbound channel that makes it external.
   */
  it("keeps both WhatsApp participants, now that the filter is not domain-shaped", () => {
    const event = ok(whatsAppToInboundEvent(message(), context)).event;

    expect(externalParticipants(event, []).map((participant) => participant.address)).toEqual([
      "+919876543210",
      "+15550001111",
    ]);
  });

  it("names a party after its own phone number when the profile name is absent", () => {
    const anonymous = ok(whatsAppToInboundEvent(message({ profileName: null }), context)).event;
    const sender = senderOf(anonymous);
    if (!sender) throw new Error("expected a sender");

    // `partyNameFor` builds a name out of the local part of an address, and a
    // phone number has none — so the profile name the adapter carries is the
    // only thing standing between the CRM and a directory of numbers.
    expect(partyNameFor(sender)).toBe("+919876543210");
    expect(partyNameFor({ ...sender, displayName: FIXTURE_CUSTOMER_NAME })).toBe(
      FIXTURE_CUSTOMER_NAME,
    );
  });
});
