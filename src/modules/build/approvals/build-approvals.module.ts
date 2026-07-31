import { Module } from "@nestjs/common";
import { ApprovalsInboxController, ApprovalsController } from "./approvals.controller";
import { ApprovalsService } from "./approvals.service";
import { ChatModule } from "../../chat/chat.module";

@Module({
  imports: [ChatModule],
  controllers: [ApprovalsInboxController, ApprovalsController],
  providers: [ApprovalsService],
})
export class BuildApprovalsModule {}
