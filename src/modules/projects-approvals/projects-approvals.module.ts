import { Module } from "@nestjs/common";
import { ApprovalsInboxController, ApprovalsController } from "./approvals.controller";
import { ApprovalsService } from "./approvals.service";

@Module({
  controllers: [ApprovalsInboxController, ApprovalsController],
  providers: [ApprovalsService],
})
export class ProjectsApprovalsModule {}
