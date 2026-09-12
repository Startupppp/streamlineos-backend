import { Controller, Headers, Param, Post, RawBodyRequest, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { ApiOkResponse } from "@nestjs/swagger";
import { Public } from "../../../../common/auth/public.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { Validate } from "../../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../../common/openapi/zod-operation-contracts";
import { CarrierWebhookReceiverService } from "./carrier-webhook.service";

const carrierCallbackParams = z
  .object({ orgId: z.string().min(1).max(100), carrierCode: z.string().min(1).max(100) })
  .strict();

/**
 * INV-26 — the URL a courier posts to.
 *
 * `@Public()`, like every other webhook receiver here, because a courier holds
 * no session. What stands in for authentication is the per-carrier shared
 * secret: the org id in the path selects which secret to check against, and the
 * signature over the raw body is what proves the caller holds it. An attacker
 * naming another organisation has to sign with that organisation's secret.
 *
 * The raw body, not the parsed one. A signature is over bytes, and
 * `JSON.parse` followed by `JSON.stringify` is not the same bytes — key order,
 * whitespace and number formatting all move. `main.ts` sets `rawBody: true`
 * for exactly this.
 *
 * The rate limit is the same shape as `billing:webhook`: generous enough for a
 * courier bursting through its retry queue, bounded so a forged-signature flood
 * cannot occupy the write path.
 */
@Public()
@Controller("webhooks/inventory/carriers")
export class CarrierWebhooksPublicController {
  constructor(private readonly receiver: CarrierWebhookReceiverService) {}

  @Post(":orgId/:carrierCode")
  @ApiOkResponse({
    description: "Callback received",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: true,
        },
      },
    },
  })
  @BodylessAction()
  @UseGuards(RateLimitGuard)
  @UseRateLimit("inventory:carrier-webhook")
  @Validate({ params: carrierCallbackParams })
  async handle(
    @Param("orgId") orgId: string,
    @Param("carrierCode") carrierCode: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.receiver.receive({
      orgId,
      carrierCode,
      rawBody: req.rawBody?.toString("utf8") ?? "",
      headers: flattenHeaders(headers),
    });
    res.status(result.status).json(result.body);
  }
}

/**
 * Express gives a repeated header as an array. An adapter reading a signature
 * must see one value or none — silently joining a repeated signature header
 * would let a caller send two and have the check pass on the concatenation.
 */
function flattenHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    flat[name.toLowerCase()] = Array.isArray(value) ? undefined : value;
  }
  return flat;
}
