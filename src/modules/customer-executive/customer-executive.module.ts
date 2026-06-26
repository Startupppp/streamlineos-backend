import { Module } from "@nestjs/common";
import { CustomerExecutiveController } from "./customer-executive.controller";
import { CustomerExecutiveService } from "./customer-executive.service";
import { CsHealthService } from "./cs-health.service";

@Module({
  controllers: [CustomerExecutiveController],
  providers: [CustomerExecutiveService, CsHealthService],
})
export class CustomerExecutiveModule {}
