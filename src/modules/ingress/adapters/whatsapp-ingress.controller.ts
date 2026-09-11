import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { Public } from "../../../common/auth/public.decorator";
import { WhatsAppChannelsService, type ResolvedWhatsAppChannel } from "./whatsapp-channels.service";
import { WhatsAppIngressService } from "./whatsapp-ingress.service";
import { whatsappDeliveryResponseSchema } from "../dto/ingress-response.schemas";

/**
 * WhatsApp, as an endpoint.
 *
 * The adapter behind this has been complete and unreachable since phase 2 — a
 * verified-delivery reader, a translator and an honest set of counts, with no
 * way for a delivery to arrive. This is that way, and it is deliberately thin:
 * every decision with consequences already lives in a tested unit below it.
 *
 * `@Public()` because a provider has no session, which is exactly why nothing
 * in the request is trusted for anything except naming a candidate row. That
 * row's own secret verifies the body, and the tenant comes from the row — never
 * from the body, which anyone on a shared Meta app can write.
 *
 * ## Why the raw body, and not `@Body()`
 *
 * The signature covers the bytes the provider sent. Re-serialising a parsed
 * object changes key order and whitespace and produces a different digest, so a
 * handler that signed `JSON.stringify(req.body)` would reject every genuine
 * delivery and pass every test built on its own serialisation. `req.rawBody` is
 * populated because `main.ts` boots with `rawBody: true`.
 *
 * ## What the status codes mean to the provider
 *
 * Meta retries anything that is not 2xx. That makes the codes a control signal
 * rather than decoration:
 *
 *   - **200** — this delivery is settled. Nothing more will be filed from it.
 *   - **401** — refused, and *uniformly* so. An unknown line, a bad signature,
 *     an unconfigured channel and an unreadable body all answer the same, so
 *     the endpoint cannot be used to ask which lines this deployment carries.
 *   - **503** — some messages reached the seam and some did not. The ones that
 *     landed are deduplicated on the provider's own message id, so a retry
 *     costs nothing and the ones that failed get another chance. Silently
 *     returning 200 here is how a channel loses a customer's message forever.
 */
@Controller("crm/ingress/whatsapp")
@Public()
export class WhatsAppIngressController {
  private readonly logger = new Logger("WhatsAppIngressController");

  constructor(
    private readonly channels: WhatsAppChannelsService,
    private readonly ingress: WhatsAppIngressService,
  ) {}

  /**
   * The subscription handshake.
   *
   * Meta calls this once, with `hub.challenge`, and will not deliver anything
   * until the challenge is echoed back verbatim as the response body — bare
   * text, not this API's `{ success, data }` envelope, which is why the
   * response is written directly rather than returned.
   *
   * The channel is in the URL because the handshake carries no phone number id;
   * there is nothing else in the request that could say which line is being
   * subscribed. A channel with no verify token configured refuses, rather than
   * comparing against the empty string and echoing back a challenge for anybody
   * who asks.
   */
  @Get(":channelId")
  @ApiOkResponse({
    description: "The `hub.challenge` value, echoed verbatim.",
    content: { "text/plain": { schema: { type: "string" } } },
  })
  async verify(
    @Param("channelId") channelId: string,
    @Query("hub.mode") mode: string | undefined,
    @Query("hub.verify_token") token: string | undefined,
    @Query("hub.challenge") challenge: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const channel = await this.channels.resolveByChannelId(channelId);

    if (
      mode !== "subscribe" ||
      !channel?.verifyToken ||
      typeof token !== "string" ||
      typeof challenge !== "string" ||
      !secretMatches(channel.verifyToken, token)
    ) {
      // 403 is what Meta's own documentation tells a subscriber to expect on a
      // token mismatch, and it is the same answer for every reason above.
      res.status(403).send();
      return;
    }

    this.logger.log(`subscription verified for channel ${channel.crmWhatsappChannelId}`);
    res.status(200).type("text/plain").send(challenge);
  }

  /**
   * A delivery on the callback URL a tenant configured.
   *
   * The channel in the path picks the candidate row; the body's
   * `phone_number_id` still has to match it, because the adapter refuses any
   * block for a line other than the binding it was handed. So a delivery
   * arriving on the wrong tenant's URL files nothing and says so.
   */
  @Post(":channelId")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(whatsappDeliveryResponseSchema)
  async deliverToChannel(
    @Param("channelId") channelId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-hub-signature-256") signature: string | undefined,
  ) {
    return this.file(await this.channels.resolveByChannelId(channelId), req, signature);
  }

  /**
   * A delivery on the deployment's shared callback URL.
   *
   * One Meta app serving several tenants has one callback URL, so the line has
   * to come out of the body: `entry[].changes[].value.metadata.phone_number_id`
   * is read to find a candidate channel, and everything after that is identical
   * to the path above — the row's secret verifies the body, the row supplies
   * the tenant, and the adapter re-checks the line against the binding.
   */
  @Post()
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(whatsappDeliveryResponseSchema)
  async deliver(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-hub-signature-256") signature: string | undefined,
  ) {
    const raw = req.rawBody?.toString("utf8") ?? "";
    const line = phoneNumberIdOf(raw);
    return this.file(line ? await this.channels.resolveByPhoneNumberId(line) : null, req, signature);
  }

  private async file(
    channel: ResolvedWhatsAppChannel | null,
    req: RawBodyRequest<Request>,
    signature: string | undefined,
  ) {
    const raw = req.rawBody?.toString("utf8") ?? "";

    /**
     * An unknown channel answers exactly as a bad signature does. Telling them
     * apart would turn this into a lookup service for which business lines this
     * deployment ingests.
     */
    if (!channel) throw new UnauthorizedException("delivery refused");

    const outcome = await this.ingress.accept(
      channel.binding,
      raw,
      signature,
      safeParse(raw),
      /**
       * The delivery arrived with no session, so nothing upstream opened a
       * tenant transaction — and the seam writes to tables behind
       * `tenant_isolation`. Without this every message verifies and none of
       * them lands.
       */
      this.channels.runInTenant,
    );
    await this.channels.recordDelivery(channel, outcome);

    if (!outcome.accepted) {
      this.logger.warn(
        `refused a delivery on channel ${channel.crmWhatsappChannelId}: ${outcome.reason}`,
      );
      throw new UnauthorizedException("delivery refused");
    }

    /**
     * Partial failure is the one case worth a retry: the seam deduplicates on
     * the provider's message id, so re-delivering the ones that landed is free
     * and the ones that did not get another chance.
     */
    if (outcome.failed > 0)
      throw new ServiceUnavailableException(
        `${outcome.failed} of ${outcome.received} message(s) could not be filed`,
      );

    return {
      received: outcome.received,
      delivered: outcome.delivered,
      duplicate: outcome.duplicate,
      inFlight: outcome.inFlight,
      ignored: outcome.ignored,
      foreign: outcome.foreign,
      skipped: outcome.skipped,
      note: outcome.note,
    };
  }
}

/**
 * The business line a body claims, read without trusting anything else in it.
 *
 * Only the first block's metadata is needed: a body carrying blocks for more
 * than one line is a relay's doing, and the adapter refuses every block that
 * does not match the binding — so reading further here would find candidates
 * this request is not going to be allowed to file against anyway.
 */
function phoneNumberIdOf(rawBody: string): string | null {
  const parsed = safeParse(rawBody);
  if (!parsed || typeof parsed !== "object") return null;

  const entries = (parsed as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return null;

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const id = (change as { value?: { metadata?: { phone_number_id?: unknown } } })?.value
        ?.metadata?.phone_number_id;
      if (typeof id === "string" && id.trim()) return id.trim();
    }
  }

  return null;
}

/** A malformed body is a refusal, never a throw out of an open endpoint. */
function safeParse(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
}

/**
 * Constant time, and length-safe.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * timing-free length oracle only because it is an exception — so the lengths
 * are compared first and the answer is the same either way.
 */
function secretMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
