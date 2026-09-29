import { Module } from "@nestjs/common";
import { PartyModule } from "../../party/party.module";
import { PortalAccessController } from "./portal-access.controller";
import { PortalAccessService } from "./portal-access.service";

@Module({
  imports: [PartyModule],
  controllers: [PortalAccessController],
  providers: [PortalAccessService],
})
export class PortalAccessModule {}
