import { Module } from "@nestjs/common";
import { AccessModule } from "../../access/access.module";
import { PartyModule } from "../../party/party.module";
import { DealsModule } from "../../deals/deals.module";
import { ActivitiesModule } from "../../activities/activities.module";
import { ReportingModule } from "../../reporting/reporting.module";
import { CrmMcpService } from "./crm-mcp.service";
import { CrmMcpController } from "./crm-mcp.controller";

@Module({
  imports: [
    AccessModule,
    PartyModule,
    DealsModule,
    ActivitiesModule,
    ReportingModule,
  ],
  controllers: [CrmMcpController],
  providers: [CrmMcpService],
  exports: [CrmMcpService],
})
export class CrmMcpModule {}
