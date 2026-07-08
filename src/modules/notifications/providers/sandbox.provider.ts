import { Logger } from "@nestjs/common";
import type { NotificationChannelProvider } from "./notification-provider.interface";
import type { NotificationChannel, ProviderSendInput, ProviderSendResult, ProviderValidationResult } from "../notification.types";

/**
 * Simulated provider used for external channels without a real integration, and for any
 * send while in sandbox mode. It never contacts an external service — it logs and returns SENT.
 */
export class SandboxProvider implements NotificationChannelProvider {
  private readonly logger = new Logger(SandboxProvider.name);

  constructor(readonly channel: NotificationChannel) {}

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    this.logger.debug(
      `SANDBOX ${this.channel} -> user ${input.userId} (${input.recipientAddress ?? "no-address"}): ${input.title}`,
    );
    return {
      status: "SENT",
      providerMessageId: `sandbox-${this.channel.toLowerCase()}-${input.userId}`,
      providerResponse: { sandbox: true, channel: this.channel },
      costAmount: 0,
      costCurrency: "USD",
    };
  }

  async validateConfig(): Promise<ProviderValidationResult> {
    return { valid: true, message: "Sandbox provider requires no configuration" };
  }

  sendTest(input: ProviderSendInput): Promise<ProviderSendResult> {
    return this.send(input);
  }
}
