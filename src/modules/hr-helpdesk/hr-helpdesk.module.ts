import { Module } from "@nestjs/common";
import { HrHelpdeskController } from "./hr-helpdesk.controller";
import { HrHelpdeskService } from "./hr-helpdesk.service";

@Module({
  controllers: [HrHelpdeskController],
  providers: [HrHelpdeskService],
})
export class HrHelpdeskModule {}
