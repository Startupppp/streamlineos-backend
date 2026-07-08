import { Injectable, Logger } from "@nestjs/common";
import type { NotificationChannelProvider } from "./notification-provider.interface";
import type { NotificationChannel, ProviderSendInput, ProviderSendResult, ProviderValidationResult } from "../notification.types";
import { WebPushService } from "../../realtime/web-push.service";

@Injectable()
export class NotificationWebPushProvider implements NotificationChannelProvider {
  readonly channel: NotificationChannel = "PUSH";
  private readonly logger = new Logger(NotificationWebPushProvider.name);

  constructor(private readonly webPush: WebPushService) {}

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    if (input.sandbox) {
      this.logger.debug(`SANDBOX PUSH -> ${input.userId}: ${input.title}`);
      return { status: "SENT", providerMessageId: "sandbox-push", providerResponse: { sandbox: true } };
    }
    if (!this.webPush.configured) {
      return { status: "FAILED", failureCode: "NO_PROVIDER", failureMessage: "Web push not configured (set VAPID keys)", retryable: false };
    }
    await this.webPush.sendToUser(input.userId, {
      title: input.title,
      body: input.message.slice(0, 140),
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
