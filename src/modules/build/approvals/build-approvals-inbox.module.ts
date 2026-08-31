import { Module } from "@nestjs/common";
import { BuildApprovalsInboxService } from "./build-approvals-inbox.service";

@Module({
  providers: [BuildApprovalsInboxService],
  exports: [BuildApprovalsInboxService],
})
export class BuildApprovalsInboxModule {}
