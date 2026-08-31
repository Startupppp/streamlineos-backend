import { Module } from "@nestjs/common";
import { ApprovalsInboxController, BuildApprovalsController } from "./approvals.controller";
import { ApprovalsService } from "./approvals.service";
import { ChatModule } from "../../chat/chat.module";

@Module({
  imports: [ChatModule],
  controllers: [ApprovalsInboxController, BuildApprovalsController],
  providers: [ApprovalsService],
})
export class BuildApprovalsModule {}
