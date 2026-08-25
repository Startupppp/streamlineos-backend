import { readWhatsAppWebhook, whatsAppSignatureMatches } from "./whatsapp-webhook";
import { signPayload } from "./mailbox-push";
import {
  deliveryBlock,
  documentMessage,
  FIXTURE_APP_SECRET,
  FIXTURE_BUSINESS_NUMBER,
  FIXTURE_CUSTOMER_NAME,
  FIXTURE_CUSTOMER_WA_ID,
  FIXTURE_PHONE_NUMBER_ID,
  imageMessage,
  signedDelivery,
  statusReceipt,
  textMessage,
  webhookBody,
} from "./whatsapp-webhook.fixture";

const read = (
  body: Record<string, unknown>,
  secret: string = FIXTURE_APP_SECRET,
) => {
  const { rawBody, signature, parsed } = signedDelivery(body, secret);
  return readWhatsAppWebhook(rawBody, signature, FIXTURE_APP_SECRET, parsed);
};

const deliveries = (verdict: ReturnType<typeof readWhatsAppWebhook>) => {
  if (!verdict.ok) throw new Error(`expected a delivery, got: ${verdict.reason}`);
  return verdict.deliveries;
};

describe("whatsAppSignatureMatches", () => {
  it("accepts the provider's own header form", () => {
    const rawBody = JSON.stringify(webhookBody());
    const digest = signPayload(FIXTURE_APP_SECRET, rawBody);
    expect(whatsAppSignatureMatches(rawBody, `sha256=${digest}`, FIXTURE_APP_SECRET)).toBe(true);
    // The prefix is a convention, not the signature.
    expect(whatsAppSignatureMatches(rawBody, digest, FIXTURE_APP_SECRET)).toBe(true);
  });

  it("rejects a body that changed after it was signed", () => {
    const { rawBody, signature } = signedDelivery();
    expect(whatsAppSignatureMatches(`${rawBody} `, signature, FIXTURE_APP_SECRET)).toBe(false);
  });

  it("rejects anything that is not a signature", () => {
    const rawBody = JSON.stringify(webhookBody());
    for (const header of [undefined, "", "sha256=", "sha256=nonsense", "£".repeat(64)])
      expect(whatsAppSignatureMatches(rawBody, header, FIXTURE_APP_SECRET)).toBe(false);
  });

  /**
   * The lesson that matters most on this channel. Unlike the mailbox push next
   * door, the signed body IS the message — there is no read-back call to check
   * it against, because the Cloud API has none. So an unconfigured secret
   * cannot mean "verify against the empty string": that digest is one an
   * attacker computes for themselves, and every forgery would verify.
   */
  it("refuses everything when no secret is configured", () => {
    const rawBody = JSON.stringify(webhookBody());
    const forged = signPayload("", rawBody);
    expect(whatsAppSignatureMatches(rawBody, `sha256=${forged}`, "")).toBe(false);
  });
});

describe("readWhatsAppWebhook", () => {
  it("reads a genuine delivery down to the message", () => {
    const [delivery] = deliveries(read(webhookBody()));
    expect(delivery).toMatchObject({
      businessPhoneNumberId: FIXTURE_PHONE_NUMBER_ID,
      businessNumber: FIXTURE_BUSINESS_NUMBER,
      ignored: 0,
    });
    expect(delivery?.messages[0]).toMatchObject({
      from: FIXTURE_CUSTOMER_WA_ID,
      type: "text",
      text: "Can you resend the quote? The last one had the old address.",
      profileName: FIXTURE_CUSTOMER_NAME,
      conversationId: null,
    });
  });

  it("refuses a forged delivery and a delivery it has no secret for", () => {
    const { rawBody, signature, parsed } = signedDelivery(webhookBody(), "some-other-secret");
    expect(readWhatsAppWebhook(rawBody, signature, FIXTURE_APP_SECRET, parsed)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(readWhatsAppWebhook(rawBody, signature, "", parsed)).toEqual({
      ok: false,
      reason: "no-secret",
    });
  });

  it("refuses a verified body that is not a webhook", () => {
    const bodies: Record<string, unknown>[] = [{ entry: "not-an-array" }, { entry: [{ changes: 7 }] }];
    for (const body of bodies)
      expect(read(body)).toEqual({ ok: false, reason: "malformed" });
  });

  /**
   * One body can carry blocks for several business numbers, and on a shared
   * relay those numbers can belong to different tenants. Flattening them into
   * one list is how one organisation's message ends up on another's timeline.
   */
  it("keeps blocks for different business lines apart", () => {
    const result = deliveries(
      read(
        webhookBody([
          deliveryBlock({ messages: [textMessage()] }),
          deliveryBlock({ messages: [textMessage({ id: "wamid.OTHER" })], phoneNumberId: "999" }),
        ]),
      ),
    );

    expect(result).toHaveLength(2);
    expect(result.map((d) => d.businessPhoneNumberId)).toEqual([FIXTURE_PHONE_NUMBER_ID, "999"]);
  });

  /**
   * Receipts arrive on the same webhook as messages. They are not
   * communications, but a block that is *all* receipts is a healthy delivery
   * with nothing to file — which has to be distinguishable from a broken one.
   */
  it("counts delivery receipts rather than filing or discarding them", () => {
    const [delivery] = deliveries(read(webhookBody([deliveryBlock({ statuses: [statusReceipt()] })])));
    expect(delivery).toMatchObject({ ignored: 1 });
    expect(delivery?.messages).toEqual([]);
  });

  it("ignores changes that are not about messages at all", () => {
    // Template approvals and quality ratings share the subscription.
    const verdict = read(
      webhookBody([deliveryBlock({ messages: [textMessage()], field: "message_template_status_update" })]),
    );
    expect(deliveries(verdict)).toEqual([]);
  });

  it("reads a document's sender-supplied filename without touching it", () => {
    const [delivery] = deliveries(read(webhookBody([deliveryBlock({ messages: [documentMessage()] })])));
    expect(delivery?.messages[0]?.media).toMatchObject({
      id: "media-9f2c",
      mimeType: "application/pdf",
      // Handed on exactly as it arrived: sanitising is `attachmentKey`'s job,
      // and doing it twice in two places is how the two stop agreeing.
      fileName: "../../etc/passwd",
      sizeBytes: null,
    });
  });

  it("reads an image, which the provider gives no filename for", () => {
    const [delivery] = deliveries(read(webhookBody([deliveryBlock({ messages: [imageMessage()] })])));
    expect(delivery?.messages[0]).toMatchObject({
      type: "image",
      // A caption is what the sender said, so it becomes the body downstream.
      text: "This is the part that arrived cracked.",
      media: { id: "media-4b7e", mimeType: "image/jpeg", fileName: null },
    });
  });

  /**
   * The media object is keyed by the message's own type. Reading whichever key
   * happens to be present would let a message whose type and payload disagree
   * carry a file it never declared.
   */
  it("takes the media the message's type names, not whatever key is present", () => {
    const mislabelled = { ...documentMessage(), type: "text", text: { body: "see attached" } };
    const [delivery] = deliveries(read(webhookBody([deliveryBlock({ messages: [mislabelled] })])));
    expect(delivery?.messages[0]?.media).toBeNull();
  });

  it("carries a conversation id through when a delivery has one", () => {
    const withConversation = { ...textMessage(), conversation: { id: "conv-77" } };
    const [delivery] = deliveries(read(webhookBody([deliveryBlock({ messages: [withConversation] })])));
    expect(delivery?.messages[0]?.conversationId).toBe("conv-77");
  });

  it("leaves the sender anonymous rather than guessing when contacts are absent", () => {
    const [delivery] = deliveries(
      read(webhookBody([deliveryBlock({ messages: [textMessage()], contacts: [] })])),
    );
    expect(delivery?.messages[0]?.profileName).toBeNull();
  });
});
