import { Module } from "@nestjs/common";
import { ApprovalsInboxController, BuildApprovalsController } from "./approvals.controller";
import { ApprovalsService } from "./approvals.service";
import { ApprovalsReadService } from "./approvals-read.service";
import { BuildInboxCountService } from "./build-inbox-count.service";
import { ChatModule } from "../../chat/chat.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { BuildApprovalRequestedConsumerService } from "./build-approval-requested-consumer.service";

@Module({
  imports: [ChatModule, NotificationsModule, OutboxModule],
  controllers: [ApprovalsInboxController, BuildApprovalsController],
  providers: [
    ApprovalsService,
    ApprovalsReadService,
    BuildInboxCountService,
    BuildApprovalRequestedConsumerService,
  ],
})
export class BuildApprovalsModule {}
