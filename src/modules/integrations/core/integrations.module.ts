import { Module } from "@nestjs/common";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { ComposioGateway } from "./composio.gateway";
import { OrgConnectionsService } from "./org-connections.service";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { WebhookEndpointService } from "./webhook-endpoint.service";
import { OutboxModule } from "../../../common/outbox/outbox.module";

@Module({
  imports: [OutboxModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, OrgConnectionsService, ComposioGateway, WebhookDeliveryService, WebhookEndpointService],
  exports: [ComposioGateway, IntegrationsService, OrgConnectionsService, WebhookDeliveryService, WebhookEndpointService],
})
export class IntegrationsModule {}
