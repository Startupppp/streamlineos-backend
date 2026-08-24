import { Module } from "@nestjs/common";
import { AutonomyModule } from "../autonomy/autonomy.module";
import { InboundIngressController } from "./inbound-ingress.controller";
import { InboundIngressService } from "./inbound-ingress.service";
import { InboundIngressWorkflow } from "./inbound-ingress.workflow";

/**
 * The inbound communications seam.
 *
 * The workflow is a provider here purely so Nest instantiates it and its
 * `onModuleInit` registers the handler — an unregistered workflow dead-letters
 * every run rather than failing loudly, so this registration is load-bearing.
 */
@Module({
  imports: [AutonomyModule],
  controllers: [InboundIngressController],
  providers: [InboundIngressService, InboundIngressWorkflow],
  exports: [InboundIngressService],
})
export class IngressModule {}
