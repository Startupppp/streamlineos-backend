import { Injectable } from "@nestjs/common";
import type { NotificationChannelProvider } from "./notification-provider.interface";
import { NotificationEmailProvider } from "./notification-email.provider";
import { NotificationWebPushProvider } from "./notification-web-push.provider";
import { SandboxProvider } from "./sandbox.provider";
import type { NotificationChannel } from "../notification.types";

/**
 * Resolves a provider implementation for a channel. EMAIL routes through the real email
 * module and PUSH through web push (both sandbox-gated); every other external channel uses a
 * sandbox provider until a real integration is wired. IN_APP is delivered inline, not here.
 */
@Injectable()
export class NotificationProviderRegistry {
  private readonly providers = new Map<NotificationChannel, NotificationChannelProvider>();

  constructor(
    private readonly email: NotificationEmailProvider,
    private readonly webPush: NotificationWebPushProvider,
  ) {
    this.providers.set("EMAIL", this.email);
    this.providers.set("PUSH", this.webPush);
    const sandboxChannels: NotificationChannel[] = ["SMS", "WHATSAPP", "SLACK", "TEAMS", "WEBHOOK"];
    for (const channel of sandboxChannels) {
      this.providers.set(channel, new SandboxProvider(channel));
    }
  }

  get(channel: NotificationChannel): NotificationChannelProvider | undefined {
    return this.providers.get(channel);
  }
}
