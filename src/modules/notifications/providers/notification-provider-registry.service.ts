import { Injectable } from "@nestjs/common";
import type { NotificationChannelProvider } from "./notification-provider.interface";
import { NotificationEmailProvider } from "./notification-email.provider";
import { NotificationWebPushProvider } from "./notification-web-push.provider";
import { SandboxProvider } from "./sandbox.provider";
import { NotificationWhatsAppProvider } from "./notification-whatsapp.provider";
import type { NotificationChannel } from "../notification.types";

/**
 * Resolves a provider implementation for a channel. EMAIL routes through the real email
 * module, PUSH through web push (both sandbox-gated) and WHATSAPP through a provider that
 * enforces template approval; every other external channel uses a sandbox provider until a
 * real integration is wired. IN_APP is delivered inline, not here.
 */
@Injectable()
export class NotificationProviderRegistry {
  private readonly providers = new Map<NotificationChannel, NotificationChannelProvider>();

  constructor(
    private readonly email: NotificationEmailProvider,
    private readonly webPush: NotificationWebPushProvider,
    private readonly whatsApp: NotificationWhatsAppProvider,
  ) {
    this.providers.set("EMAIL", this.email);
    this.providers.set("PUSH", this.webPush);
    // COMP-005: WHATSAPP is no longer a generic sandbox channel — it enforces template
    // approval before sending, which the sandbox provider (always SENT) could not.
    this.providers.set("WHATSAPP", this.whatsApp);
    const sandboxChannels: NotificationChannel[] = ["SMS", "WEBHOOK"];
    for (const channel of sandboxChannels) {
      this.providers.set(channel, new SandboxProvider(channel));
    }
  }

  get(channel: NotificationChannel): NotificationChannelProvider | undefined {
    return this.providers.get(channel);
  }
}
