import { Module } from "@nestjs/common";
import { PortalAccessController } from "./portal-access.controller";
import { PortalAccessService } from "./portal-access.service";

@Module({
  controllers: [PortalAccessController],
  providers: [PortalAccessService],
})
export class PortalAccessModule {}
