import { Module } from "@nestjs/common";
import { ApprovalsInboxController, BuildApprovalsController } from "./approvals.controller";
import { ApprovalsService } from "./approvals.service";
import { ApprovalsReadService } from "./approvals-read.service";
import { BuildInboxCountService } from "./build-inbox-count.service";
import { ChatModule } from "../../chat/chat.module";

@Module({
  imports: [ChatModule],
  controllers: [ApprovalsInboxController, BuildApprovalsController],
  providers: [ApprovalsService, ApprovalsReadService, BuildInboxCountService],
})
export class BuildApprovalsModule {}
