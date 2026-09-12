import { Module } from "@nestjs/common";
import { AccessModule } from "../../access/access.module";
import { PartyModule } from "../../party/party.module";
import { DealsModule } from "../../deals/deals.module";
import { ActivitiesModule } from "../../activities/activities.module";
import { ReportingModule } from "../../reporting/reporting.module";
import { CrmMcpService } from "./crm-mcp.service";
import { CrmMcpController } from "./crm-mcp.controller";
import { CrmMcpSettingsService } from "./crm-mcp-settings.service";
import { CrmMcpSettingsController } from "./crm-mcp-settings.controller";

@Module({
  imports: [
    AccessModule,
    PartyModule,
    DealsModule,
    ActivitiesModule,
    ReportingModule,
  ],
  /**
   * The switch is its own controller and its own route.
   *
   * `CrmMcpController` carries `@AllowAgentToken()`; this one must not, because
   * a credential that could turn its own access back on is not a switch. Keeping
   * them as separate classes is what stops that happening by accident when
   * somebody adds a route later.
   */
  controllers: [CrmMcpController, CrmMcpSettingsController],
  providers: [CrmMcpService, CrmMcpSettingsService],
  exports: [CrmMcpService, CrmMcpSettingsService],
})
export class CrmMcpModule {}
