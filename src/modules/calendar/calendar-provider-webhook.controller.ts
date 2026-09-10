import { Body, Controller, Headers, HttpCode, Post } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { CalendarProviderWebhookService } from "./calendar-provider-webhook.service";
import {
  providerWebhookBodySchema,
  webhookHandleResponseSchema,
  type ProviderWebhookBody,
} from "./dto/provider-webhook.schemas";
import {
  assertCalendarWebhookSecret,
  CALENDAR_WEBHOOK_SECRET_HEADER,
} from "./calendar-webhook-secret";

@Public()
@Controller("webhooks/calendar")
export class CalendarProviderWebhookController {
  constructor(private readonly webhooks: CalendarProviderWebhookService) {}

  @Post("provider")
  @ResponseSchema(webhookHandleResponseSchema)
  @HttpCode(200)
  @Validate({ body: providerWebhookBodySchema })
  async handle(
    @Body() body: ProviderWebhookBody,
    @Headers(CALENDAR_WEBHOOK_SECRET_HEADER) secret: string | undefined,
  ): Promise<{ action: string }> {
    assertCalendarWebhookSecret(secret);

    const result = await this.webhooks.handleDelivery({
      connectionId: body.connectionId,
      externalEventId: body.externalEventId,
      providerUpdatedAtIso: body.providerUpdatedAt,
    });
    return { action: result.action };
  }
}
