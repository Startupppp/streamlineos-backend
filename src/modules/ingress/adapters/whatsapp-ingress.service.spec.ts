import { ConflictException } from "@nestjs/common";
import type { InboundIngressService, AcceptOutcome } from "../inbound-ingress.service";
import type { InboundCommunicationEvent } from "../inbound-event";
import { WhatsAppIngressService, type WhatsAppChannelBinding } from "./whatsapp-ingress.service";
import {
  deliveryBlock,
  documentMessage,
  FIXTURE_APP_SECRET,
  FIXTURE_BUSINESS_NUMBER,
  FIXTURE_PHONE_NUMBER_ID,
  signedDelivery,
  statusReceipt,
  textMessage,
  webhookBody,
} from "./whatsapp-webhook.fixture";

/**
 * The channel as its caller meets it.
 *
 * The whole thing runs off one fixture body and this repo's own ingress
 * service; no provider SDK is mocked, because inbound WhatsApp is a signed HTTP
 * body rather than a call we make. What is substituted is the seam itself, at
 * its own interface, so that what this file proves is what the adapter hands
 * over and what it says afterwards — never what the pipeline does with it.
 */

const binding: WhatsAppChannelBinding = {
  organizationId: "org-1",
  businessPhoneNumberId: FIXTURE_PHONE_NUMBER_ID,
  businessNumber: FIXTURE_BUSINESS_NUMBER,
  appSecret: FIXTURE_APP_SECRET,
};

/** A seam that accepts everything, and remembers what it was handed. */
function seam(answers: (AcceptOutcome | Error)[] = []) {
  const seen: InboundCommunicationEvent[] = [];
  let call = 0;

  const ingress = {
    accept: jest.fn(async (event: InboundCommunicationEvent) => {
      seen.push(event);
      const answer = answers[call];
      call += 1;
      if (answer instanceof Error) throw answer;
      return (
        answer ?? {
          status: "accepted" as const,
          inboundEventId: `receipt-${call}`,
          workflowRunId: "run-1",
        }
      );
    }),
  } as unknown as InboundIngressService;

  return { ingress, seen };
}

const accepted = (outcome: Awaited<ReturnType<WhatsAppIngressService["accept"]>>) => {
  if (!outcome.accepted) throw new Error(`expected an accepted delivery, got: ${outcome.reason}`);
  return outcome;
};

const deliver = async (
  body: Record<string, unknown>,
  answers: (AcceptOutcome | Error)[] = [],
  over: Partial<WhatsAppChannelBinding> = {},
  secret: string = FIXTURE_APP_SECRET,
) => {
  const { ingress, seen } = seam(answers);
  const { rawBody, signature, parsed } = signedDelivery(body, secret);
  const outcome = await new WhatsAppIngressService(ingress).accept(
    { ...binding, ...over },
    rawBody,
    signature,
    parsed,
  );
  return { outcome, seen, ingress };
};

describe("WhatsAppIngressService", () => {
  it("offers each message to the seam and says what became of it", async () => {
    const { outcome, seen } = await deliver(
      webhookBody([deliveryBlock({ messages: [textMessage(), documentMessage()] })]),
    );

    expect(accepted(outcome)).toMatchObject({
      received: 2,
      delivered: 2,
      duplicate: 0,
      failed: 0,
      note: null,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ organizationId: "org-1", provider: "whatsapp", channel: "message" });
  });

  it("never reaches the seam with a delivery it cannot verify", async () => {
    const { outcome, ingress } = await deliver(webhookBody(), [], {}, "somebody-elses-secret");
    expect(outcome).toEqual({ accepted: false, reason: "bad-signature" });
    expect(ingress.accept).not.toHaveBeenCalled();
  });

  it("refuses everything while the channel has no secret", async () => {
    const { outcome, ingress } = await deliver(webhookBody(), [], { appSecret: "" });
    expect(outcome).toEqual({ accepted: false, reason: "no-secret" });
    expect(ingress.accept).not.toHaveBeenCalled();
  });

  /**
   * A shared app signs every tenant's deliveries with the same secret, so the
   * signature proves the provider sent it and nothing about who it is for.
   * Matching the business line is what does — and being loud about it, because
   * a line bound to the wrong phone number id looks exactly like a quiet week.
   */
  it("files nothing from a block addressed to another business line, and says so", async () => {
    const { outcome, ingress } = await deliver(
      webhookBody([deliveryBlock({ messages: [textMessage()], phoneNumberId: "999" })]),
    );

    const result = accepted(outcome);
    expect(result).toMatchObject({ received: 0, delivered: 0, foreign: 1 });
    expect(result.note).toContain("different business line");
    expect(ingress.accept).not.toHaveBeenCalled();
  });

  /**
   * The thread identity is half made of the business number, so taking it from
   * the body would let whoever wrote the body choose which thread the messages
   * join.
   */
  it("threads on the binding's own number, never the one in the body", async () => {
    const { seen } = await deliver(
      webhookBody([deliveryBlock({ messages: [textMessage()] })]),
      [],
      { businessNumber: "+1 555 000 1111" },
    );

    expect(seen[0]?.providerThreadId).toBe("org-1:message:+15550001111|+919876543210");
  });

  it("counts a redelivery as a duplicate rather than a failure", async () => {
    const { outcome } = await deliver(webhookBody(), [
      { status: "duplicate", inboundEventId: "receipt-1" },
    ]);

    expect(accepted(outcome)).toMatchObject({ received: 1, delivered: 0, duplicate: 1, failed: 0 });
  });

  /**
   * Two deliveries of the same message racing each other is the seam's own
   * conflict, not a broken channel — the first one is handling it.
   */
  it("counts a concurrent retry as in flight, not failed", async () => {
    const { outcome } = await deliver(webhookBody(), [
      new ConflictException({ code: "DELIVERY_IN_FLIGHT" }),
    ]);

    expect(accepted(outcome)).toMatchObject({ inFlight: 1, failed: 0, delivered: 0 });
  });

  it("does not let one message the seam rejects lose the rest of the batch", async () => {
    const { outcome, seen } = await deliver(
      webhookBody([
        deliveryBlock({ messages: [textMessage(), textMessage({ id: "wamid.SECOND" })] }),
      ]),
      [new Error("the seam said no")],
    );

    expect(accepted(outcome)).toMatchObject({ received: 2, delivered: 1, failed: 1 });
    expect(seen).toHaveLength(2);
  });

  /**
   * A body of read receipts is a healthy delivery with nothing to file. It has
   * to be distinguishable from a channel that is broken, which is why one is
   * silent and everything else below is not.
   */
  it("stays quiet about a delivery that was only receipts", async () => {
    const { outcome } = await deliver(webhookBody([deliveryBlock({ statuses: [statusReceipt()] })]));
    expect(accepted(outcome)).toMatchObject({ received: 0, ignored: 1, note: null });
  });

  /**
   * The failure this module has already paid for once: a channel that reads,
   * files nothing, and reports itself healthy. Every refusal is named and
   * counted so that cannot happen quietly.
   */
  it("names the refusals when messages arrived and none were filed", async () => {
    const { outcome } = await deliver(
      webhookBody([
        deliveryBlock({
          messages: [
            textMessage({ type: "reaction", text: undefined }),
            textMessage({ id: "wamid.SECOND", type: "location", text: undefined }),
          ],
        }),
      ]),
    );

    const result = accepted(outcome);
    expect(result).toMatchObject({ received: 2, delivered: 0, skipped: { "unsupported-type": 2 } });
    expect(result.note).toContain("2 unsupported-type");
  });

  it("surfaces what would be captured from the media it saw", async () => {
    const { outcome } = await deliver(
      webhookBody([deliveryBlock({ messages: [documentMessage()] })]),
    );

    const result = accepted(outcome);
    expect(result.media).toHaveLength(1);
    // Refused, correctly: the webhook declares no size, and `decideAttachment`
    // will not treat an undeclared size as zero.
    expect(result.media[0]?.decision).toEqual({ capture: false, reason: "size-unknown" });
  });
});
