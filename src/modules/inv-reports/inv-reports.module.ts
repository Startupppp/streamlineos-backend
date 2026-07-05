import { Module } from "@nestjs/common";
import { InvReportsController } from "./inv-reports.controller";
import { InvReportsService } from "./inv-reports.service";
import { InvReportsExtendedService } from "./inv-reports-extended.service";

@Module({
  controllers: [InvReportsController],
  providers: [InvReportsService, InvReportsExtendedService],
  exports: [InvReportsService, InvReportsExtendedService],
})
export class InvReportsModule {}
