import { Module } from "@nestjs/common";
import { AutonomyModule } from "../autonomy/autonomy.module";
import { BillingModule } from "../billing/core/billing.module";
import { MailModule } from "../mail/mail.module";
import { RelationshipsModule } from "../relationships/relationships.module";
import { CrmMailboxController } from "./adapters/crm-mailbox.controller";
import { CrmMailboxService } from "./adapters/crm-mailbox.service";
import { InboundIngressController } from "./inbound-ingress.controller";
import { InboundIngressService } from "./inbound-ingress.service";
import { InboundIngressWorkflow } from "./inbound-ingress.workflow";
import { WhatsAppChannelsController } from "./adapters/whatsapp-channels.controller";
import { WhatsAppChannelsService } from "./adapters/whatsapp-channels.service";
import { WhatsAppIngressController } from "./adapters/whatsapp-ingress.controller";
import { WhatsAppIngressService } from "./adapters/whatsapp-ingress.service";

/**
 * The inbound communications seam.
 *
 * The workflow is a provider here purely so Nest instantiates it and its
 * `onModuleInit` registers the handler — an unregistered workflow dead-letters
 * every run rather than failing loudly, so this registration is load-bearing.
 */
@Module({
  imports: [AutonomyModule, BillingModule, MailModule, RelationshipsModule],
  controllers: [
    InboundIngressController,
    CrmMailboxController,
    WhatsAppIngressController,
    WhatsAppChannelsController,
  ],
  providers: [
    InboundIngressService,
    InboundIngressWorkflow,
    CrmMailboxService,
    WhatsAppChannelsService,
    WhatsAppIngressService,
  ],
  exports: [InboundIngressService, CrmMailboxService, WhatsAppChannelsService],
})
export class IngressModule {}
