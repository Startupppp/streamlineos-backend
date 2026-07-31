import { Module } from "@nestjs/common";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { ComposioGateway } from "./composio.gateway";

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, ComposioGateway],
  exports: [ComposioGateway, IntegrationsService],
})
export class IntegrationsModule {}
