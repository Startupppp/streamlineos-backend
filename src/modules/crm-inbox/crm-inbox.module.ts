import { Module } from "@nestjs/common";
import { DrizzleModule } from "../../db/drizzle.module";
import { CrmAutomationStudioModule } from "../crm-automation-studio/crm-automation-studio.module";
import { CrmInboxController } from "./crm-inbox.controller";
import { CrmInboxService } from "./crm-inbox.service";

@Module({
  imports: [DrizzleModule, CrmAutomationStudioModule],
  controllers: [CrmInboxController],
  providers: [CrmInboxService],
})
export class CrmInboxModule {}
