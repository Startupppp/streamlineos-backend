import { Injectable } from "@nestjs/common";
import type { NotificationChannelProvider } from "./notification-provider.interface";
import type { NotificationChannel, ProviderSendInput, ProviderSendResult, ProviderValidationResult } from "../notification.types";
import { WebPushService } from "../../realtime/web-push.service";
import { logger } from "../../../common/logger/logger.service";

@Injectable()
export class NotificationWebPushProvider implements NotificationChannelProvider {
  readonly channel: NotificationChannel = "PUSH";

  constructor(private readonly webPush: WebPushService) {}

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    if (input.sandbox) {
      logger.debug("sandbox push not dispatched", {
        orgId: input.orgId,
        userId: input.userId,
        channel: this.channel,
      });
      return { status: "SENT", providerMessageId: "sandbox-push", providerResponse: { sandbox: true } };
    }
    if (!this.webPush.configured) {
      return { status: "FAILED", failureCode: "NO_PROVIDER", failureMessage: "Web push not configured (set VAPID keys)", retryable: false };
    }
    // RT-001: no content crosses the push boundary. The delivery row carries no
    // category, so the service worker falls back to its generic label.
    await this.webPush.sendToUser(input.orgId, input.userId, {
      url: input.link ?? "/notifications",
    });
    return { status: "SENT", providerResponse: { channel: "PUSH" } };
  }

  async validateConfig(): Promise<ProviderValidationResult> {
    return this.webPush.configured
      ? { valid: true, message: "Web push configured" }
      : { valid: false, message: "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set" };
  }

  sendTest(input: ProviderSendInput): Promise<ProviderSendResult> {
    return this.send(input);
  }
}
