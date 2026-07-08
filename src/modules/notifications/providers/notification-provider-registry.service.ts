import { Injectable } from "@nestjs/common";
import type { NotificationChannelProvider } from "./notification-provider.interface";
import { NotificationEmailProvider } from "./notification-email.provider";
import { SandboxProvider } from "./sandbox.provider";
import type { NotificationChannel } from "../notification.types";

/**
 * Resolves a provider implementation for a channel. EMAIL routes through the real email
 * module (sandbox-gated); every other external channel currently uses a sandbox provider
 * until a real integration is wired. IN_APP is delivered inline and never appears here.
 */
@Injectable()
export class NotificationProviderRegistry {
  private readonly providers = new Map<NotificationChannel, NotificationChannelProvider>();

  constructor(private readonly email: NotificationEmailProvider) {
    this.providers.set("EMAIL", this.email);
    const sandboxChannels: NotificationChannel[] = ["PUSH", "SMS", "WHATSAPP", "SLACK", "TEAMS", "WEBHOOK"];
    for (const channel of sandboxChannels) {
      this.providers.set(channel, new SandboxProvider(channel));
    }
  }

  get(channel: NotificationChannel): NotificationChannelProvider | undefined {
    return this.providers.get(channel);
  }
}
