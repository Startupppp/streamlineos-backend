import { Module } from "@nestjs/common";
import { AutonomyModule } from "../autonomy/autonomy.module";
import { IntegrationsModule } from "../integrations/core/integrations.module";
import { MailModule } from "../mail/mail.module";
import { CrmMailboxController } from "./adapters/crm-mailbox.controller";
import { CrmMailboxService } from "./adapters/crm-mailbox.service";
import { TelephonyCallLogService } from "./adapters/telephony-call-log.service";
import { WhatsAppIngressService } from "./adapters/whatsapp-ingress.service";
import { InboundIngressController } from "./inbound-ingress.controller";
import { InboundIngressService } from "./inbound-ingress.service";
import { InboundIngressWorkflow } from "./inbound-ingress.workflow";

/**
 * The inbound communications seam.
 *
 * The workflow is a provider here purely so Nest instantiates it and its
 * `onModuleInit` registers the handler — an unregistered workflow dead-letters
 * every run rather than failing loudly, so this registration is load-bearing.
 *
 * Every channel adapter that carries an `@Injectable()` is listed below, and
 * that completeness is what `pnpm check:module-di` now enforces. The telephony
 * and WhatsApp adapters were written complete and left out of this list, so
 * Nest never constructed them and their dependencies were never resolved at
 * boot — a class nobody provides is dead however green its spec is.
 * `IntegrationsModule` is imported because `TelephonyCallLogService` reaches
 * the carrier through `ComposioGateway`, and `MailModule` imports that module
 * without re-exporting it, so it is not visible here by inheritance.
 */
@Module({
  imports: [AutonomyModule, IntegrationsModule, MailModule],
  controllers: [InboundIngressController, CrmMailboxController],
  providers: [
    InboundIngressService,
    InboundIngressWorkflow,
    CrmMailboxService,
    TelephonyCallLogService,
    WhatsAppIngressService,
  ],
})
export class IngressModule {}
