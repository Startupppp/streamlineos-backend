import { Module } from "@nestjs/common";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { ComposioGateway } from "./composio.gateway";
import { OrgConnectionsService } from "./org-connections.service";

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, OrgConnectionsService, ComposioGateway],
  exports: [ComposioGateway, IntegrationsService, OrgConnectionsService],
})
export class IntegrationsModule {}
