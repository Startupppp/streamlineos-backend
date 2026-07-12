import { Module } from "@nestjs/common";
import { DrizzleModule } from "../../db/drizzle.module";
import { CrmInboxController } from "./crm-inbox.controller";
import { CrmInboxService } from "./crm-inbox.service";

@Module({
  imports: [DrizzleModule],
  controllers: [CrmInboxController],
  providers: [CrmInboxService],
})
export class CrmInboxModule {}
