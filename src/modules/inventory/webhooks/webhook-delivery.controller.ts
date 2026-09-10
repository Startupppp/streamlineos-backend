import { Controller, Get, Headers, HttpCode, Post } from "@nestjs/common";
import { Public } from "../../../common/auth/public.decorator";
import { assertCronSecret } from "../../cron/cron-secret";
import {
  InventoryWebhookDeliveryWorker,
  type WebhookDeliverySweepResult,
} from "./webhook-delivery.worker";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

/**
 * E7 — the scheduler entry point for outbound webhook delivery.
 *
 * It lives beside the worker rather than in `modules/cron/` for the same reason
 * `WorkflowsCronController` does: the route is part of this module's contract,
 * and putting it in the cron module would make `CronModule` import the whole of
 * inventory to reach one method. `assertCronSecret` is the gate — the route is
 * `@Public()` because the caller is a scheduler with no session, not because it
 * is unauthenticated.
 *
 * Both verbs are exposed because platform schedulers differ on which they issue,
 * and a worker that only answers POST is a worker that silently never runs.
 */
@Public()
@Controller("cron")
export class InventoryWebhookDeliveryController {
  constructor(private readonly worker: InventoryWebhookDeliveryWorker) {}

  @Get("inventory-webhook-delivery")
  runGet(@Headers("authorization") authorization?: string): Promise<WebhookDeliverySweepResult> {
    return this.run(authorization);
  }

  @Post("inventory-webhook-delivery")
  @BodylessAction()
  @HttpCode(200)
  runPost(@Headers("authorization") authorization?: string): Promise<WebhookDeliverySweepResult> {
    return this.run(authorization);
  }

  private run(authorization?: string): Promise<WebhookDeliverySweepResult> {
    assertCronSecret(authorization);
    return this.worker.run();
  }
}
