import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { InboundIngressService } from "../inbound-ingress.service";
import { readWhatsAppWebhook } from "./whatsapp-webhook";
import {
  whatsAppToInboundEvent,
  type WhatsAppMediaDecision,
  type WhatsAppSkipReason,
} from "./whatsapp-to-inbound-event";

/**
 * A WhatsApp business line feeding the CRM.
 *
 * Everything provider-shaped has already happened by the time this runs: the
 * signature is checked and the envelope is read in `whatsapp-webhook`, the
 * translation happens in `whatsapp-to-inbound-event`, and what is left is the
 * part that has consequences — offering each message to the seam, and being
 * honest about what came of it.
 *
 * There is no sweep and no watermark here, and that is a property of the
 * channel rather than an omission. The Cloud API has no call that reads inbound
 * messages; they exist only as pushes. So the mailbox's "read forward from a
 * high-water mark" has no analogue, and its failure mode — a watermark moving
 * past mail that was never read — cannot occur. The failure mode that *can* is
 * the other one: a delivery that verifies, parses, files nothing and reports
 * itself healthy. Every count below exists so that cannot happen quietly.
 *
 * Deliberately not registered in `IngressModule`: the ingress module is shared
 * with two other channel adapters landing in the same tree, and the wiring —
 * this provider, its controller, and where the channel binding is stored — is
 * one decision that should be made once rather than three times. See the
 * ticket report.
 */

/**
 * The organisation's end of a WhatsApp conversation.
 *
 * Passed in rather than looked up, because where it is stored is the open
 * question. `user_integration_connections` is where the platform rule says a
 * Composio connection is mirrored, but its `toolkit` union is closed over
 * `gmail`, `outlook` and `googlecalendar`, so widening it is a schema change
 * this ticket is not permitted to make.
 */
export interface WhatsAppChannelBinding {
  readonly organizationId: string;
  /** `metadata.phone_number_id` — what a delivery has to match to be ours. */
  readonly businessPhoneNumberId: string;
  /** The business's own number, as the other end of the participant pair. */
  readonly businessNumber: string;
  /**
   * The secret the provider signs deliveries with.
   *
   * Never a provider access token: it authenticates the provider to us, and it
   * cannot be used to act as the organisation anywhere. Nothing that could is
   * stored — the outbound half of this channel, and the media download the
   * decisions below stop short of, both go through Composio's connected
   * account, where the credentials stay.
   */
  readonly appSecret: string;
}

/** The label this adapter is known by in the deduplication key. */
export const WHATSAPP_PROVIDER = "whatsapp";

export interface WhatsAppAcceptSummary {
  /** Messages in this body that belong to this binding. */
  readonly received: number;
  readonly delivered: number;
  /** Already filed by an earlier delivery of the same message. */
  readonly duplicate: number;
  /** A concurrent retry; the first delivery is still being processed. */
  readonly inFlight: number;
  readonly failed: number;
  /** Delivery and read receipts, which are not communications. */
  readonly ignored: number;
  /** Blocks in this body addressed to a different business line. */
  readonly foreign: number;
  readonly skipped: Readonly<Record<WhatsAppSkipReason, number>>;
  /** What would be captured from the media on these messages, decided not fetched. */
  readonly media: readonly WhatsAppMediaDecision[];
  /**
   * Set when the delivery was well-formed and produced nothing.
   *
   * A channel that reports healthy while filing nothing is the worst failure
   * this module has: it is indistinguishable from a quiet week until somebody
   * goes looking for a conversation that was never there. The note names the
   * reason so the answer is on the delivery rather than in a log somewhere.
   */
  readonly note: string | null;
}

export type WhatsAppAcceptOutcome =
  | ({ readonly accepted: true } & WhatsAppAcceptSummary)
  | {
      readonly accepted: false;
      readonly reason: "bad-signature" | "no-secret" | "malformed";
    };

const NO_SKIPS: Record<WhatsAppSkipReason, number> = {
  "no-identifier": 0,
  "no-sender": 0,
  "no-business-number": 0,
  "own-number-noise": 0,
  "unsupported-type": 0,
  empty: 0,
};

@Injectable()
export class WhatsAppIngressService {
  private readonly logger = new Logger("WhatsAppIngress");

  constructor(private readonly ingress: InboundIngressService) {}

  /**
   * One verified delivery, offered to the seam a message at a time.
   *
   * `rawBody` must be the bytes as received — the signature covers those, not a
   * re-serialisation of the parsed object.
   *
   * Returns counts rather than throwing, because the caller is answering a
   * provider that retries on anything other than a 2xx. A `failed` count above
   * zero is the one case worth a non-2xx: the messages that did land are
   * deduplicated by the seam, so a retry costs nothing and the ones that did
   * not get another chance.
   */
  async accept(
    binding: WhatsAppChannelBinding,
    rawBody: string,
    signature: string | undefined,
    parsed: unknown,
  ): Promise<WhatsAppAcceptOutcome> {
    const verdict = readWhatsAppWebhook(rawBody, signature, binding.appSecret, parsed);
    if (!verdict.ok) return { accepted: false, reason: verdict.reason };

    const skipped = { ...NO_SKIPS };
    const media: WhatsAppMediaDecision[] = [];
    let received = 0;
    let delivered = 0;
    let duplicate = 0;
    let inFlight = 0;
    let failed = 0;
    let ignored = 0;
    let foreign = 0;

    for (const delivery of verdict.deliveries) {
      /**
       * A block for another business line is refused, never filed.
       *
       * The phone number id comes out of the body, and the body was signed by
       * the provider rather than by this organisation — on a shared app, one
       * tenant's delivery and another's are signed with the same secret. So the
       * signature says the provider sent it; it does not say who it is for.
       * Matching the line is what does.
       */
      if (delivery.businessPhoneNumberId !== binding.businessPhoneNumberId) {
        foreign += 1;
        continue;
      }

      ignored += delivery.ignored;

      for (const message of delivery.messages) {
        received += 1;

        const result = whatsAppToInboundEvent(message, {
          organizationId: binding.organizationId,
          provider: WHATSAPP_PROVIDER,
          /**
           * The binding's number, not the delivery's.
           *
           * `display_phone_number` is in a body somebody else wrote, and it is
           * half of the thread identity — taking it from the wire would let a
           * delivery choose which thread its messages join.
           */
          businessNumber: binding.businessNumber,
        });

        if (!result.ok) {
          skipped[result.reason] += 1;
          continue;
        }

        media.push(...result.media);

        /**
         * One at a time, so one message the seam rejects cannot lose the rest
         * of the delivery. The seam deduplicates on the provider's own id, so
         * the overlap a retry produces costs nothing.
         */
        try {
          const outcome = await this.ingress.accept(result.event);
          if (outcome.status === "duplicate") duplicate += 1;
          else delivered += 1;
        } catch (error) {
          if (error instanceof ConflictException) {
            inFlight += 1;
            continue;
          }
          failed += 1;
          this.logger.warn(
            `could not file ${message.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    const note = deliveryNote({ received, delivered, duplicate, failed, ignored, foreign, skipped });
    if (note) this.logger.warn(note);

    return {
      accepted: true,
      received,
      delivered,
      duplicate,
      inFlight,
      failed,
      ignored,
      foreign,
      skipped,
      media,
      note,
    };
  }

}

/**
 * What a delivery that succeeded and filed nothing leaves behind.
 *
 * Silence here would be the bug: every count can be zero for a perfectly good
 * reason — a body of read receipts, a repeat of one already handled — and every
 * count can be zero because the channel is broken. Naming which one it was is
 * the difference.
 */
function deliveryNote(summary: {
  received: number;
  delivered: number;
  duplicate: number;
  failed: number;
  ignored: number;
  foreign: number;
  skipped: Record<WhatsAppSkipReason, number>;
}): string | null {
  if (summary.delivered > 0) return null;

  if (summary.foreign > 0 && summary.received === 0)
    return `A verified delivery carried ${summary.foreign} block(s) for a different business line and none for this one. Either the line is bound to the wrong phone number id, or another tenant's webhook is pointed here.`;

  if (summary.received === 0)
    return summary.ignored > 0
      ? null
      : "A verified delivery carried no messages and no receipts. Nothing was filed.";

  if (summary.failed === summary.received)
    return `All ${summary.received} message(s) failed on the way to the seam. Nothing was filed and the provider should retry.`;

  const refused = Object.entries(summary.skipped)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(", ");

  if (refused && summary.duplicate === 0)
    return `${summary.received} message(s) arrived and none were filed — refused as: ${refused}.`;

  return null;
}
