import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../../common/auth/public.decorator";
import { NoTenantTransaction } from "../../../common/tenant/no-tenant-transaction.decorator";
import { logger } from "../../../common/logger/logger.service";
import { ChannelSnapshotService } from "./channel-snapshot.service";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { channelInboundResponseSchema } from "./dto/channels-response.schemas";

/**
 * E6 — the inbound channel webhook. Verify, acknowledge, enqueue.
 *
 * ## Why this route is `@Public()`
 *
 * The caller is a marketplace with no session, exactly as `integrations/git` is.
 * `@Public()` here means "authenticated by signature rather than by JWT", not
 * "unauthenticated": `ChannelSnapshotService.receiveDelivery` refuses anything
 * whose HMAC does not verify against the deployment secret for that channel
 * type, and a delivery that fails verification is recorded nowhere.
 *
 * ## Why it acknowledges a rejection with 202 too
 *
 * It does not. A rejection is 401, because a channel whose signature is wrong
 * needs to hear that rather than believe it delivered. What it *does*
 * acknowledge with 202 is a **duplicate**: a marketplace retrying a delivery it
 * already sent has done nothing wrong, and answering 4xx would make it retry
 * harder. The duplicate enqueues nothing, which is E6's done-when.
 *
 * ## Why the work is not done here
 *
 * "Ack fast" is not a preference. Every marketplace bounds how long it waits —
 * Shopify's limit is five seconds — and treats a slow response as a failed
 * delivery, so doing the refetch inline would produce retries that each start
 * another refetch. It would also hold a pooled Postgres connection, inside a
 * tenant transaction, for the length of somebody else's outage
 * (backend/CLAUDE.md §4). The durable `PENDING` row is the queue;
 * `ChannelSnapshotWorker` drains it.
 *
 * `@NoTenantTransaction()` because there is no session to derive a tenant from:
 * the service resolves the organisation from the channel id through a
 * `SECURITY DEFINER` resolver and opens its own tenant transaction. Leaving the
 * interceptor to try would open nothing anyway — this makes the reason explicit
 * rather than incidental.
 */
@Public()
@NoTenantTransaction()
@Controller("inventory/channels")
export class ChannelWebhookController {
  constructor(private readonly snapshots: ChannelSnapshotService) {}

  @Post("inbound/:channelId")
  @BodylessAction()
  @ResponseSchema(channelInboundResponseSchema)
  @HttpCode(HttpStatus.ACCEPTED)
  async inbound(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ accepted: boolean; duplicate?: boolean }> {
    // The raw bytes, not a re-serialised parse: `JSON.parse` then
    // `JSON.stringify` reorders keys and normalises whitespace, so a digest over
    // the round-trip verifies nothing about what was sent. `rawBody: true` in
    // `main.ts` is what makes these available.
    const rawBody = req.rawBody?.toString("utf8") ?? "";

    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }

    const outcome = await this.snapshots.receiveDelivery({ channelId, rawBody, headers });

    if (!outcome.accepted) {
      // The reason goes to our log and never into the response. Telling a caller
      // that the channel exists but the signature is wrong, versus that the
      // channel does not exist, is an existence oracle for anybody enumerating
      // serial channel ids (§4). One 401, one message, whatever went wrong.
      logger.warn("[channel-webhook] delivery rejected", { channelId, reason: outcome.reason });
      throw new UnauthorizedException("Unauthorized");
    }

    return { accepted: true, duplicate: outcome.duplicate };
  }
}
