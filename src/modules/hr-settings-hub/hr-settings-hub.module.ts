import { Module } from "@nestjs/common";
import { HrSettingsHubController } from "./hr-settings-hub.controller";
import { HrSettingsHubService } from "./hr-settings-hub.service";
import { HrPoliciesModule } from "../hr-policies/hr-policies.module";

@Module({
  imports: [HrPoliciesModule],
  controllers: [HrSettingsHubController],
  providers: [HrSettingsHubService],
})
export class HrSettingsHubModule {}
